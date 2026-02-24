from pydantic import BaseModel, EmailStr, field_validator
from typing import Optional
from datetime import datetime


class UserRegister(BaseModel):
    email: EmailStr
    username: str
    password: str

    @field_validator("username")
    @classmethod
    def username_valid(cls, v):
        if len(v) < 2 or len(v) > 30:
            raise ValueError("Username must be 2-30 characters")
        return v

    @field_validator("password")
    @classmethod
    def password_valid(cls, v):
        if len(v) < 6:
            raise ValueError("Password must be at least 6 characters")
        return v


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"


class UserOut(BaseModel):
    id: int
    email: str
    username: str
    tl_balance: float
    tlc_balance: float
    tl_locked: float
    tl_suspended: bool
    poc_index: float
    false_dispute_strikes: int
    account_forfeited: bool
    exchangeable_tl: float
    created_at: Optional[datetime]

    model_config = {"from_attributes": True}


class WalletSummary(BaseModel):
    tl_balance: float
    tl_locked: float
    tlc_balance: float
    total_tl_spent: float
    total_tl_earned: float
    total_tl_exchanged: float
    exchangeable_tl: float
    poc_index: float
    tl_suspended: bool
    false_dispute_strikes: int
    account_forfeited: bool

    model_config = {"from_attributes": True}
