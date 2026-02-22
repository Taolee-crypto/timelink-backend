from pydantic import BaseModel, EmailStr, Field
from typing import Optional
from datetime import datetime

# 공통 속성
class UserBase(BaseModel):
    email: EmailStr
    username: str
    bio: Optional[str] = None
    profile_image: Optional[str] = None

# 생성 시
class UserCreate(UserBase):
    password: str

# 업데이트 시
class UserUpdate(BaseModel):
    username: Optional[str] = None
    bio: Optional[str] = None
    profile_image: Optional[str] = None
    car_mode_enabled: Optional[bool] = None
    auto_recharge_enabled: Optional[bool] = None
    auto_recharge_threshold: Optional[int] = None
    auto_recharge_amount: Optional[int] = None

# 응답
class UserResponse(UserBase):
    id: int
    tl_balance: int
    tl_locked: int
    trust_score: float
    lvs_score: float
    car_mode_enabled: bool
    auto_recharge_enabled: bool
    auto_recharge_threshold: int
    auto_recharge_amount: int
    created_at: datetime
    updated_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True

# TL 토큰 관련
class TLChargeRequest(BaseModel):
    amount: int = Field(..., ge=100, le=100000)

class TLTransferRequest(BaseModel):
    to_user_id: int
    amount: int = Field(..., ge=1)
