from pydantic import BaseModel, field_validator
from typing import Optional
from datetime import datetime


class DisputeCreate(BaseModel):
    file_id: int
    category: str
    reason: str

    @field_validator("reason")
    @classmethod
    def reason_min_length(cls, v):
        if len(v) < 50:
            raise ValueError("Reason must be at least 50 characters")
        return v

    @field_validator("category")
    @classmethod
    def category_valid(cls, v):
        allowed = {"copyright", "fake", "abuse", "other"}
        if v not in allowed:
            raise ValueError(f"Category must be one of {allowed}")
        return v


class DisputeResolve(BaseModel):
    upheld: bool          # True=인용, False=기각(허위)
    result_note: str


class DisputeOut(BaseModel):
    id: int
    file_id: int
    disputer_user_id: int
    category: str
    reason: str
    status: str
    result_note: Optional[str]
    days_remaining: int
    false_strike_added: bool
    created_at: Optional[datetime]
    resolved_at: Optional[datetime]

    model_config = {"from_attributes": True}
