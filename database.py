import sqlite3
import os
import hashlib
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "atm.db")

def get_db_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def hash_pin(pin: str) -> str:
    """Hashes a PIN using SHA-256 for secure comparison."""
    return hashlib.sha256(pin.encode('utf-8')).hexdigest()

def init_db(overwrite=False):
    """Initializes the database schema and seeds default mock data."""
    if overwrite and os.path.exists(DB_PATH):
        os.remove(DB_PATH)
        
    db_exists = os.path.exists(DB_PATH)
    conn = get_db_connection()
    cursor = conn.cursor()

    # Create tables if they don't exist
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_number TEXT UNIQUE NOT NULL,
        holder_name TEXT NOT NULL,
        balance REAL NOT NULL DEFAULT 0.0
    )
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS cards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_number TEXT UNIQUE NOT NULL,
        pin_hash TEXT NOT NULL,
        pin_hint TEXT,
        card_theme TEXT,
        account_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'LOCKED'
        attempts INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (account_id) REFERENCES accounts (id)
    )
    """)

    # Check if pin_hint and card_theme columns exist, if not add them (migration for existing databases)
    cursor.execute("PRAGMA table_info(cards)")
    columns = [row[1] for row in cursor.fetchall()]
    if "pin_hint" not in columns:
        cursor.execute("ALTER TABLE cards ADD COLUMN pin_hint TEXT")
        cursor.execute("UPDATE cards SET pin_hint = '1234' WHERE card_number = '1234567890123456'")
        cursor.execute("UPDATE cards SET pin_hint = '4321' WHERE card_number = '9876543210987654'")
        cursor.execute("UPDATE cards SET pin_hint = '9999' WHERE card_number = '1111222233334444'")
    
    if "card_theme" not in columns:
        cursor.execute("ALTER TABLE cards ADD COLUMN card_theme TEXT")

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        type TEXT NOT NULL, -- 'WITHDRAWAL', 'DEPOSIT', 'PIN_CHANGE', 'BALANCE_INQUIRY'
        amount REAL NOT NULL,
        timestamp TEXT NOT NULL,
        status TEXT NOT NULL, -- 'SUCCESS', 'FAILED'
        details TEXT,
        FOREIGN KEY (account_id) REFERENCES accounts (id)
    )
    """)

    cursor.execute("""
    CREATE TABLE IF NOT EXISTS atm_state (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cash_balance REAL NOT NULL DEFAULT 5000.0,
        last_refill TEXT NOT NULL
    )
    """)

    conn.commit()

    # Seed mock data if database is fresh
    cursor.execute("SELECT COUNT(*) FROM accounts")
    if cursor.fetchone()[0] == 0:
        # Seed Accounts
        accounts = [
            ("ACC-774921", "Alice Smith", 1500.00),
            ("ACC-110842", "Bob Jones", 450.50),
            ("ACC-902511", "Charlie Brown", 12500.00)
        ]
        cursor.executemany(
            "INSERT INTO accounts (account_number, holder_name, balance) VALUES (?, ?, ?)", 
            accounts
        )

        # Retrieve inserted account IDs
        cursor.execute("SELECT id, holder_name FROM accounts")
        account_map = {row["holder_name"]: row["id"] for row in cursor.fetchall()}

        # Seed Cards
        # PINs: Alice: 1234, Bob: 4321, Charlie: 9999
        cards = [
            ("1234567890123456", hash_pin("1234"), "1234", account_map["Alice Smith"]),
            ("9876543210987654", hash_pin("4321"), "4321", account_map["Bob Jones"]),
            ("1111222233334444", hash_pin("9999"), "9999", account_map["Charlie Brown"])
        ]
        cursor.executemany(
            "INSERT INTO cards (card_number, pin_hash, pin_hint, account_id) VALUES (?, ?, ?, ?)",
            cards
        )

        # Seed ATM State
        cursor.execute(
            "INSERT INTO atm_state (cash_balance, last_refill) VALUES (?, ?)",
            (5000.00, datetime.now().isoformat())
        )

        conn.commit()
        print("Database initialized and seeded with mock data.")
    else:
        print("Database already exists. Skipping seed.")

    conn.close()

if __name__ == "__main__":
    init_db(overwrite=False)
