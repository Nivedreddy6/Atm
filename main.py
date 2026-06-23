import os
import uuid
import sqlite3
from datetime import datetime
from fastapi import FastAPI, Header, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from database import DB_PATH, get_db_connection, hash_pin, init_db
import random
from schemas import (
    CardInsertRequest,
    PinVerifyRequest,
    WithdrawRequest,
    DepositRequest,
    ChangePinRequest,
    AdminRefillRequest,
    CreateUserRequest,
)

app = FastAPI(title="Python Interactive ATM API", version="1.0.0")

# Apply database migrations on startup without overwriting user data
init_db(overwrite=False)

# Allow CORS for easy testing
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_no_cache_headers(request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response

# In-memory session store: token -> session dict
ACTIVE_SESSIONS = {}

def get_current_session(authorization: str = Header(None)):
    """Dependency to retrieve and validate session token from the Authorization header."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Unauthorized: No session token provided")
    
    token = authorization.split(" ")[1]
    if token not in ACTIVE_SESSIONS:
        raise HTTPException(status_code=401, detail="Unauthorized: Invalid or expired session")
    
    # Check if card is still active in the database (not locked since session creation)
    session = ACTIVE_SESSIONS[token]
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT status FROM cards WHERE card_number = ?", (session["card_number"],))
    row = cursor.fetchone()
    conn.close()
    
    if not row or row["status"] != "ACTIVE":
        # Eject session if locked
        ACTIVE_SESSIONS.pop(token, None)
        raise HTTPException(status_code=403, detail="Session expired: Card has been locked")
        
    return session

def log_transaction(account_id: int, type_: str, amount: float, status: str, details: str = None):
    """Helper to record a transaction in the database."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "INSERT INTO transactions (account_id, type, amount, timestamp, status, details) VALUES (?, ?, ?, ?, ?, ?)",
        (account_id, type_, amount, datetime.now().isoformat(), status, details)
    )
    conn.commit()
    conn.close()

# --- AUTH ROUTES ---

@app.post("/api/auth/insert-card")
def insert_card(payload: CardInsertRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute(
        """
        SELECT c.status, c.attempts, a.holder_name 
        FROM cards c 
        JOIN accounts a ON c.account_id = a.id 
        WHERE c.card_number = ?
        """,
        (payload.card_number,)
    )
    row = cursor.fetchone()
    conn.close()
    
    if not row:
        raise HTTPException(status_code=404, detail="Card not recognized by this ATM")
    
    if row["status"] == "LOCKED":
        raise HTTPException(status_code=403, detail="Card is locked due to too many failed PIN attempts. Contact your bank.")
        
    return {
        "status": "PIN_REQUIRED",
        "holder_name": row["holder_name"]
    }

@app.post("/api/auth/verify-pin")
def verify_pin(payload: PinVerifyRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute(
        """
        SELECT c.id as card_id, c.pin_hash, c.status, c.attempts, c.account_id, a.account_number, a.holder_name, a.balance 
        FROM cards c 
        JOIN accounts a ON c.account_id = a.id 
        WHERE c.card_number = ?
        """,
        (payload.card_number,)
    )
    row = cursor.fetchone()
    
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Card not recognized")
        
    if row["status"] == "LOCKED":
        conn.close()
        raise HTTPException(status_code=403, detail="Card is locked")
        
    input_hash = hash_pin(payload.pin)
    
    if input_hash == row["pin_hash"]:
        # Reset failed attempts
        cursor.execute("UPDATE cards SET attempts = 0 WHERE id = ?", (row["card_id"],))
        conn.commit()
        conn.close()
        
        # Create user session
        session_token = str(uuid.uuid4())
        session_data = {
            "card_number": payload.card_number,
            "account_id": row["account_id"],
            "account_number": row["account_number"],
            "holder_name": row["holder_name"]
        }
        ACTIVE_SESSIONS[session_token] = session_data
        
        # Log Inquiry of session start
        log_transaction(row["account_id"], "BALANCE_INQUIRY", 0.0, "SUCCESS", "Card authorized successfully")
        
        return {
            "status": "AUTHORIZED",
            "token": session_token,
            "holder_name": row["holder_name"],
            "account_number": row["account_number"]
        }
    else:
        new_attempts = row["attempts"] + 1
        status = "ACTIVE"
        if new_attempts >= 3:
            status = "LOCKED"
            
        cursor.execute("UPDATE cards SET attempts = ?, status = ? WHERE id = ?", (new_attempts, status, row["card_id"]))
        conn.commit()
        conn.close()
        
        # Log failure
        log_transaction(row["account_id"], "BALANCE_INQUIRY", 0.0, "FAILED", f"Invalid PIN attempt ({new_attempts}/3)")
        
        if status == "LOCKED":
            raise HTTPException(status_code=403, detail="Card has been locked due to 3 failed attempts.")
        else:
            raise HTTPException(status_code=401, detail=f"Incorrect PIN. Attempts remaining: {3 - new_attempts}")

@app.post("/api/auth/eject-card")
def eject_card(authorization: str = Header(None)):
    if authorization and authorization.startswith("Bearer "):
        token = authorization.split(" ")[1]
        ACTIVE_SESSIONS.pop(token, None)
    return {"status": "EJECTED"}

# --- ACCOUNT TRANSACTIONS ---

@app.get("/api/account/balance")
def get_balance(session: dict = Depends(get_current_session)):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT balance FROM accounts WHERE id = ?", (session["account_id"],))
    row = cursor.fetchone()
    conn.close()
    
    if not row:
        raise HTTPException(status_code=404, detail="Account not found")
        
    return {
        "balance": row["balance"],
        "holder_name": session["holder_name"],
        "account_number": session["account_number"]
    }

@app.post("/api/account/withdraw")
def withdraw(payload: WithdrawRequest, session: dict = Depends(get_current_session)):
    amount = payload.amount
    
    # 1. ATM Rules validation
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Invalid withdrawal amount")
    if amount % 10 != 0:
        raise HTTPException(status_code=400, detail="ATM can only dispense bills in multiples of $10 ($10, $20, $50, $100)")
    if amount > 1000:
        raise HTTPException(status_code=400, detail="Maximum single withdrawal limit is $1,000")
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 2. Check ATM cash vault level
    cursor.execute("SELECT cash_balance FROM atm_state ORDER BY id DESC LIMIT 1")
    atm_row = cursor.fetchone()
    if not atm_row or atm_row["cash_balance"] < amount:
        conn.close()
        log_transaction(session["account_id"], "WITHDRAWAL", amount, "FAILED", f"ATM short of cash. Available: ${atm_row['cash_balance'] if atm_row else 0}")
        raise HTTPException(status_code=400, detail="Transaction cancelled: ATM does not have sufficient cash. Please try a lower amount.")
        
    # 2.5 Check daily withdrawal limit ($1,000 max today)
    today_start = datetime.now().date().isoformat()
    cursor.execute(
        """
        SELECT SUM(amount) FROM transactions 
        WHERE account_id = ? AND type = 'WITHDRAWAL' AND status = 'SUCCESS' AND timestamp >= ?
        """,
        (session["account_id"], today_start)
    )
    withdrawn_today = cursor.fetchone()[0] or 0.0
    if withdrawn_today + amount > 1000.0:
        conn.close()
        log_transaction(session["account_id"], "WITHDRAWAL", amount, "FAILED", f"Exceeded daily limit. Already withdrawn today: ${withdrawn_today}")
        raise HTTPException(
            status_code=400, 
            detail=f"Transaction cancelled: Daily withdrawal limit is $1,000. You have already withdrawn ${withdrawn_today:.2f} today."
        )

    # 3. Check Account balance
    cursor.execute("SELECT balance FROM accounts WHERE id = ?", (session["account_id"],))
    acc_row = cursor.fetchone()
    if not acc_row or acc_row["balance"] < amount:
        conn.close()
        log_transaction(session["account_id"], "WITHDRAWAL", amount, "FAILED", "Insufficient account balance")
        raise HTTPException(status_code=400, detail="Transaction cancelled: Insufficient funds in your account.")
        
    try:
        # Perform withdrawal inside a SQL transaction
        new_acc_balance = acc_row["balance"] - amount
        new_atm_balance = atm_row["cash_balance"] - amount
        
        cursor.execute("UPDATE accounts SET balance = ? WHERE id = ?", (new_acc_balance, session["account_id"]))
        cursor.execute("UPDATE atm_state SET cash_balance = ? WHERE id = (SELECT id FROM atm_state ORDER BY id DESC LIMIT 1)", (new_atm_balance,))
        
        # Log successful transaction
        cursor.execute(
            "INSERT INTO transactions (account_id, type, amount, timestamp, status, details) VALUES (?, ?, ?, ?, ?, ?)",
            (session["account_id"], "WITHDRAWAL", amount, datetime.now().isoformat(), "SUCCESS", f"Dispensed ${amount}")
        )
        
        conn.commit()
        
        # Determine optimal bill breakdown for frontend representation
        bills = break_down_bills(amount)
        
        return {
            "status": "SUCCESS",
            "dispensed_amount": amount,
            "new_balance": new_acc_balance,
            "bills": bills
        }
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Database transaction error: {str(e)}")
    finally:
        conn.close()

def break_down_bills(amount: int) -> dict:
    """Greedy algorithm to return optimal bill counts for the cash slot."""
    bills = {100: 0, 50: 0, 20: 0, 10: 0}
    remaining = amount
    for bill in [100, 50, 20, 10]:
        count = remaining // bill
        if count > 0:
            bills[bill] = count
            remaining %= bill
    return bills

@app.post("/api/account/deposit")
def deposit(payload: DepositRequest, session: dict = Depends(get_current_session)):
    amount = payload.amount
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Invalid deposit amount")
    if amount > 5000:
        raise HTTPException(status_code=400, detail="Maximum single deposit limit is $5,000")
        
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT balance FROM accounts WHERE id = ?", (session["account_id"],))
    acc_row = cursor.fetchone()
    
    cursor.execute("SELECT cash_balance FROM atm_state ORDER BY id DESC LIMIT 1")
    atm_row = cursor.fetchone()
    
    if not acc_row or not atm_row:
        conn.close()
        raise HTTPException(status_code=404, detail="Entity state not found")
        
    try:
        new_acc_balance = acc_row["balance"] + amount
        new_atm_balance = atm_row["cash_balance"] + amount
        
        cursor.execute("UPDATE accounts SET balance = ? WHERE id = ?", (new_acc_balance, session["account_id"]))
        cursor.execute("UPDATE atm_state SET cash_balance = ? WHERE id = (SELECT id FROM atm_state ORDER BY id DESC LIMIT 1)", (new_atm_balance,))
        
        cursor.execute(
            "INSERT INTO transactions (account_id, type, amount, timestamp, status, details) VALUES (?, ?, ?, ?, ?, ?)",
            (session["account_id"], "DEPOSIT", amount, datetime.now().isoformat(), "SUCCESS", f"Deposited ${amount}")
        )
        
        conn.commit()
        return {
            "status": "SUCCESS",
            "new_balance": new_acc_balance
        }
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Database transaction error: {str(e)}")
    finally:
        conn.close()

@app.post("/api/account/change-pin")
def change_pin(payload: ChangePinRequest, session: dict = Depends(get_current_session)):
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT pin_hash FROM cards WHERE account_id = ?", (session["account_id"],))
    row = cursor.fetchone()
    
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Card associated with account not found")
        
    if hash_pin(payload.old_pin) != row["pin_hash"]:
        conn.close()
        log_transaction(session["account_id"], "PIN_CHANGE", 0.0, "FAILED", "Incorrect old PIN verification")
        raise HTTPException(status_code=401, detail="Verification failed: Current PIN is incorrect.")
        
    try:
        new_hash = hash_pin(payload.new_pin)
        cursor.execute("UPDATE cards SET pin_hash = ?, pin_hint = ? WHERE account_id = ?", (new_hash, payload.new_pin, session["account_id"]))
        
        cursor.execute(
            "INSERT INTO transactions (account_id, type, amount, timestamp, status, details) VALUES (?, ?, ?, ?, ?, ?)",
            (session["account_id"], "PIN_CHANGE", 0.0, datetime.now().isoformat(), "SUCCESS", "PIN updated successfully")
        )
        conn.commit()
        return {"status": "SUCCESS"}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Database transaction error: {str(e)}")
    finally:
        conn.close()

@app.get("/api/account/transactions")
def get_transactions(session: dict = Depends(get_current_session)):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute(
        "SELECT type, amount, timestamp, status, details FROM transactions WHERE account_id = ? ORDER BY id DESC LIMIT 10",
        (session["account_id"],)
    )
    rows = cursor.fetchall()
    conn.close()
    
    history = []
    for r in rows:
        history.append({
            "type": r["type"],
            "amount": r["amount"],
            "timestamp": r["timestamp"],
            "status": r["status"],
            "details": r["details"]
        })
    return history

# --- ADMIN ROUTES ---

@app.get("/api/admin/status")
def get_admin_status():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT cash_balance, last_refill FROM atm_state ORDER BY id DESC LIMIT 1")
    atm_row = cursor.fetchone()
    
    cursor.execute("SELECT COUNT(*) FROM accounts")
    total_users = cursor.fetchone()[0]
    
    cursor.execute("SELECT COUNT(*) FROM transactions")
    total_transactions = cursor.fetchone()[0]
    
    cursor.execute("SELECT COUNT(*) FROM cards WHERE status = 'LOCKED'")
    locked_cards = cursor.fetchone()[0]
    
    # Get all transactions to print in admin log
    cursor.execute(
        """
        SELECT t.type, t.amount, t.timestamp, t.status, t.details, a.holder_name 
        FROM transactions t
        JOIN accounts a ON t.account_id = a.id
        ORDER BY t.id DESC LIMIT 30
        """
    )
    tx_list = [dict(row) for row in cursor.fetchall()]
    
    # Get user lists to display cards/PINs for convenient testing
    cursor.execute(
        """
        SELECT a.holder_name, a.account_number, a.balance, c.card_number, c.status, c.pin_hint, c.card_theme
        FROM accounts a
        JOIN cards c ON c.account_id = a.id
        """
    )
    users = [dict(row) for row in cursor.fetchall()]
    
    conn.close()
    
    return {
        "atm_cash": atm_row["cash_balance"] if atm_row else 0.0,
        "last_refill": atm_row["last_refill"] if atm_row else "",
        "total_users": total_users,
        "total_transactions": total_transactions,
        "locked_cards": locked_cards,
        "recent_transactions": tx_list,
        "users": users
    }

@app.post("/api/admin/refill")
def admin_refill(payload: AdminRefillRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT cash_balance FROM atm_state ORDER BY id DESC LIMIT 1")
    row = cursor.fetchone()
    current_cash = row["cash_balance"] if row else 0.0
    
    new_cash = current_cash + payload.amount
    
    cursor.execute(
        "UPDATE atm_state SET cash_balance = ?, last_refill = ? WHERE id = (SELECT id FROM atm_state ORDER BY id DESC LIMIT 1)",
        (new_cash, datetime.now().isoformat())
    )
    conn.commit()
    conn.close()
    
    return {
        "status": "SUCCESS",
        "new_cash_balance": new_cash
    }

@app.post("/api/admin/unlock-card")
def admin_unlock_card(payload: CardInsertRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("SELECT id FROM cards WHERE card_number = ?", (payload.card_number,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Card not found")
        
    cursor.execute("UPDATE cards SET status = 'ACTIVE', attempts = 0 WHERE card_number = ?", (payload.card_number,))
    conn.commit()
    conn.close()
    
    return {"status": "SUCCESS"}

@app.post("/api/admin/create-user")
def admin_create_user(payload: CreateUserRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # 1. Check if card number already exists
    cursor.execute("SELECT id FROM cards WHERE card_number = ?", (payload.card_number,))
    if cursor.fetchone():
        conn.close()
        raise HTTPException(status_code=400, detail="Card number already registered")
        
    try:
        # 2. Generate unique account number
        while True:
            acc_num = f"ACC-{random.randint(100000, 999999)}"
            cursor.execute("SELECT id FROM accounts WHERE account_number = ?", (acc_num,))
            if not cursor.fetchone():
                break
                
        # 3. Create account
        cursor.execute(
            "INSERT INTO accounts (account_number, holder_name, balance) VALUES (?, ?, ?)",
            (acc_num, payload.holder_name, payload.initial_balance)
        )
        account_id = cursor.lastrowid
        
        # 4. Create card
        hashed = hash_pin(payload.pin)
        cursor.execute(
            "INSERT INTO cards (card_number, pin_hash, pin_hint, card_theme, account_id) VALUES (?, ?, ?, ?, ?)",
            (payload.card_number, hashed, payload.pin, payload.card_theme, account_id)
        )
        
        # 5. Log transaction initial deposit
        cursor.execute(
            "INSERT INTO transactions (account_id, type, amount, timestamp, status, details) VALUES (?, ?, ?, ?, ?, ?)",
            (account_id, "DEPOSIT", payload.initial_balance, datetime.now().isoformat(), "SUCCESS", "Account opened successfully")
        )
        
        conn.commit()
        return {"status": "SUCCESS", "account_number": acc_num}
    except Exception as e:
        conn.rollback()
        raise HTTPException(status_code=500, detail=f"Database error: {str(e)}")
    finally:
        conn.close()

# Serve static files
# Create static directory if it doesn't exist
static_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
if not os.path.exists(static_dir):
    os.makedirs(static_dir)

@app.get("/")
def read_root():
    return FileResponse(os.path.join(static_dir, "index.html"))

app.mount("/", StaticFiles(directory=static_dir), name="static")
