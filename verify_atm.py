import os
import sqlite3
import unittest
from fastapi.testclient import TestClient

import database
# Force tests to run against a separate test database to avoid wiping the main user database
TEST_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test_atm.db")
database.DB_PATH = TEST_DB_PATH

from database import hash_pin, init_db
from main import app, break_down_bills, ACTIVE_SESSIONS

class TestATMBankSystem(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Reset and seed database for testing
        init_db(overwrite=True)
        cls.client = TestClient(app)
        
        # Keep track of card credentials
        cls.alice_card = "1234567890123456"
        cls.alice_pin = "1234"
        cls.bob_card = "9876543210987654"
        cls.bob_pin = "4321"

    @classmethod
    def tearDownClass(cls):
        # Remove the test database file after all tests finish
        if os.path.exists(database.DB_PATH):
            try:
                os.remove(database.DB_PATH)
            except Exception:
                pass

    def setUp(self):
        # Clear active sessions and reset db before each test to ensure test isolation
        init_db(overwrite=True)
        ACTIVE_SESSIONS.clear()

    def test_database_seeding(self):
        """Verify mock tables are seeded with correct details."""
        conn = sqlite3.connect(database.DB_PATH)
        cursor = conn.cursor()
        
        # Test Alice's Account Balance
        cursor.execute("SELECT balance, holder_name FROM accounts WHERE holder_name = 'Alice Smith'")
        row = cursor.fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row[0], 1500.00)
        
        # Test card links
        cursor.execute("SELECT status FROM cards WHERE card_number = ?", (self.alice_card,))
        card_row = cursor.fetchone()
        self.assertIsNotNone(card_row)
        self.assertEqual(card_row[0], "ACTIVE")
        
        conn.close()

    def test_bill_breakdown(self):
        """Test the ATM bill dispenser greedy logic."""
        # Test $120
        self.assertEqual(break_down_bills(120), {100: 1, 50: 0, 20: 1, 10: 0})
        # Test $380
        self.assertEqual(break_down_bills(380), {100: 3, 50: 1, 20: 1, 10: 1})
        # Test $10
        self.assertEqual(break_down_bills(10), {100: 0, 50: 0, 20: 0, 10: 1})

    def test_pin_hashing(self):
        """Verify the PIN SHA-256 hash output is correct."""
        self.assertEqual(hash_pin("1234"), hash_pin("1234"))
        self.assertNotEqual(hash_pin("1234"), hash_pin("1235"))

    def test_card_insertion_success(self):
        """Verify a valid card inserting is accepted and asks for PIN."""
        res = self.client.post("/api/auth/insert-card", json={"card_number": self.alice_card})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "PIN_REQUIRED")
        self.assertEqual(res.json()["holder_name"], "Alice Smith")

    def test_card_insertion_invalid(self):
        """Verify invalid cards are rejected."""
        res = self.client.post("/api/auth/insert-card", json={"card_number": "0000000000000000"})
        self.assertEqual(res.status_code, 404)

    def test_pin_verification_success(self):
        """Test successful PIN validation generates session token."""
        # Trigger Insert Card
        self.client.post("/api/auth/insert-card", json={"card_number": self.alice_card})
        
        # Verify PIN
        res = self.client.post("/api/auth/verify-pin", json={
            "card_number": self.alice_card,
            "pin": self.alice_pin
        })
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "AUTHORIZED")
        self.assertIn("token", res.json())
        self.assertEqual(res.json()["holder_name"], "Alice Smith")

    def test_pin_verification_fail_and_lock(self):
        """Test that 3 incorrect PIN inputs locks the card."""
        card_num = self.bob_card
        
        # 1st failed attempt
        res = self.client.post("/api/auth/verify-pin", json={"card_number": card_num, "pin": "0000"})
        self.assertEqual(res.status_code, 401)
        self.assertIn("Attempts remaining: 2", res.json()["detail"])
        
        # 2nd failed attempt
        res = self.client.post("/api/auth/verify-pin", json={"card_number": card_num, "pin": "0000"})
        self.assertEqual(res.status_code, 401)
        self.assertIn("Attempts remaining: 1", res.json()["detail"])
        
        # 3rd failed attempt - Lock Card
        res = self.client.post("/api/auth/verify-pin", json={"card_number": card_num, "pin": "0000"})
        self.assertEqual(res.status_code, 403)
        self.assertIn("locked", res.json()["detail"])
        
        # Subsequent insertion of locked card should fail
        res = self.client.post("/api/auth/insert-card", json={"card_number": card_num})
        self.assertEqual(res.status_code, 403)
        self.assertIn("locked", res.json()["detail"])

    def test_authorized_account_balance(self):
        """Test getting balance for authenticated user."""
        # Authenticate Alice
        login_res = self.client.post("/api/auth/verify-pin", json={
            "card_number": self.alice_card,
            "pin": self.alice_pin
        })
        token = login_res.json()["token"]
        
        # Check Balance
        headers = {"Authorization": f"Bearer {token}"}
        bal_res = self.client.get("/api/account/balance", headers=headers)
        self.assertEqual(bal_res.status_code, 200)
        self.assertEqual(bal_res.json()["balance"], 1500.00)

    def test_withdrawal_validations(self):
        """Verify withdrawal requirements (multiples of 10, balance check)."""
        # Authenticate Alice
        login_res = self.client.post("/api/auth/verify-pin", json={
            "card_number": self.alice_card,
            "pin": self.alice_pin
        })
        token = login_res.json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        
        # Withdraw non-multiple of 10
        res = self.client.post("/api/account/withdraw", json={"amount": 25.0}, headers=headers)
        self.assertEqual(res.status_code, 400)
        self.assertIn("multiples of $10", res.json()["detail"])
        
        # Withdraw over limit
        res = self.client.post("/api/account/withdraw", json={"amount": 15000.0}, headers=headers)
        self.assertEqual(res.status_code, 400)
        
        # Successful Withdrawal
        res = self.client.post("/api/account/withdraw", json={"amount": 100.0}, headers=headers)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["new_balance"], 1400.00)
        self.assertEqual(res.json()["dispensed_amount"], 100.00)

    def test_deposit_validations(self):
        """Verify deposit requirements (greater than 0, maximum limit, updating balance)."""
        # Authenticate Alice
        login_res = self.client.post("/api/auth/verify-pin", json={
            "card_number": self.alice_card,
            "pin": self.alice_pin
        })
        token = login_res.json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        
        # Deposit <= 0 (fails Pydantic gt=0 schema check)
        res = self.client.post("/api/account/deposit", json={"amount": 0}, headers=headers)
        self.assertEqual(res.status_code, 422)
        
        # Deposit > 5000
        res = self.client.post("/api/account/deposit", json={"amount": 6000}, headers=headers)
        self.assertEqual(res.status_code, 400)
        
        # Successful Deposit of $200
        res = self.client.post("/api/account/deposit", json={"amount": 200.0}, headers=headers)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["new_balance"], 1700.00)

    def test_change_pin_validations(self):
        """Verify PIN change requirements (valid old PIN, changing to new PIN)."""
        # Authenticate Alice (initial PIN 1234)
        login_res = self.client.post("/api/auth/verify-pin", json={
            "card_number": self.alice_card,
            "pin": self.alice_pin
        })
        token = login_res.json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        
        # Change PIN with incorrect old PIN
        res = self.client.post("/api/account/change-pin", json={
            "old_pin": "9999",
            "new_pin": "5555"
        }, headers=headers)
        self.assertEqual(res.status_code, 401)
        
        # Change PIN successfully
        res = self.client.post("/api/account/change-pin", json={
            "old_pin": self.alice_pin,
            "new_pin": "5555"
        }, headers=headers)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "SUCCESS")
        
        # Test logging in with the NEW PIN
        login_res2 = self.client.post("/api/auth/verify-pin", json={
            "card_number": self.alice_card,
            "pin": "5555"
        })
        self.assertEqual(login_res2.status_code, 200)
        self.assertEqual(login_res2.json()["status"], "AUTHORIZED")

    def test_admin_create_user(self):
        """Test admin creating a new user and card in the database."""
        theme_json = '{"color_start":"#ff0000","color_end":"#0000ff","pattern":"grid","emblem":"★"}'
        res = self.client.post("/api/admin/create-user", json={
            "holder_name": "Test User",
            "card_number": "5555555555555555",
            "pin": "5555",
            "initial_balance": 100.0,
            "card_theme": theme_json
        })
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["status"], "SUCCESS")
        acc_num = res.json()["account_number"]
        self.assertTrue(acc_num.startswith("ACC-"))
        
        # Test logging in with new card
        login_res = self.client.post("/api/auth/verify-pin", json={
            "card_number": "5555555555555555",
            "pin": "5555"
        })
        self.assertEqual(login_res.status_code, 200)
        self.assertEqual(login_res.json()["holder_name"], "Test User")

        # Test card_theme is returned in admin status
        status_res = self.client.get("/api/admin/status")
        self.assertEqual(status_res.status_code, 200)
        users = status_res.json()["users"]
        test_user_card = next(u for u in users if u["card_number"] == "5555555555555555")
        self.assertEqual(test_user_card["card_theme"], theme_json)

    def test_daily_withdrawal_limit(self):
        """Test daily withdrawal cumulative limit of $1,000."""
        # Authenticate Charlie (balance: 12500)
        login_res = self.client.post("/api/auth/verify-pin", json={
            "card_number": "1111222233334444",
            "pin": "9999"
        })
        token = login_res.json()["token"]
        headers = {"Authorization": f"Bearer {token}"}
        
        # Withdraw $800 (Success)
        res = self.client.post("/api/account/withdraw", json={"amount": 800.0}, headers=headers)
        self.assertEqual(res.status_code, 200)
        
        # Withdraw another $300 (Fails, total is $1100 > $1000 limit)
        res = self.client.post("/api/account/withdraw", json={"amount": 300.0}, headers=headers)
        self.assertEqual(res.status_code, 400)
        self.assertIn("Daily withdrawal limit is $1,000", res.json()["detail"])

if __name__ == "__main__":
    unittest.main()
