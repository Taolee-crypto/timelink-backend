from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class FileUploadMeta(BaseModel):
    title: str
    artist: str = ""
    genre: str = ""
    country: str = "kr"
    file_tl: float = 1000.0   # 충전할 TL (파일 잔고)


class AuthRequestCreate(BaseModel):
    source_url: str
    profile_url: Optional[str] = None
    plan_type: Optional[str] = None
    creation_month: Optional[str] = None
    email_proof: Optional[str] = None
    extra_notes: Optional[str] = None


class FileOut(BaseModel):
    id: int
    user_id: int
    title: str
    artist: str
    genre: str
    country: str
    file_type: str
    file_url: str
    file_tl: float
    max_file_tl: float
    auth_status: str
    auth_type: Optional[str]
    shared: bool
    pulse: int
    play_count: int
    revenue: float
    hold_revenue: float
    revenue_held: bool
    created_at: Optional[datetime]

    model_config = {"from_attributes": True}


class FileShare(BaseModel):
    shared: bool


class TLChargeRequest(BaseModel):
    amount: float
