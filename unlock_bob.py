import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "atm.db")

def unlock_bob():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute(
        "UPDATE cards SET status = 'ACTIVE', attempts = 0 WHERE card_number = '9876543210987654'"
    )
    conn.commit()
    conn.close()
    print("Bob Jones card unlocked in database.")

if __name__ == "__main__":
    unlock_bob()
