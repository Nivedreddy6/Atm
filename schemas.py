from pydantic import BaseModel, Field

class CardInsertRequest(BaseModel):
    card_number: str = Field(..., min_length=16, max_length=16, description="16-digit card number")

class PinVerifyRequest(BaseModel):
    card_number: str = Field(..., min_length=16, max_length=16)
    pin: str = Field(..., min_length=4, max_length=6, description="4 to 6 digit ATM PIN")

class WithdrawRequest(BaseModel):
    amount: float = Field(..., gt=0, description="Amount to withdraw")

class DepositRequest(BaseModel):
    amount: float = Field(..., gt=0, description="Amount to deposit")

class ChangePinRequest(BaseModel):
    old_pin: str = Field(..., min_length=4, max_length=6)
    new_pin: str = Field(..., min_length=4, max_length=6)

class AdminRefillRequest(BaseModel):
    amount: float = Field(..., gt=0)

class CreateUserRequest(BaseModel):
    holder_name: str = Field(..., min_length=2, max_length=50)
    card_number: str = Field(..., min_length=16, max_length=16)
    pin: str = Field(..., min_length=4, max_length=6)
    initial_balance: float = Field(..., ge=0)
    card_theme: str = Field(None, description="Optional card layout theme settings as JSON string")
