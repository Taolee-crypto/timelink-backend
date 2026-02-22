from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime
from app.schemas.user import UserResponse

# 공통 속성
class TimelinePostBase(BaseModel):
    content: str
    media_url: Optional[str] = None

# 생성 시
class TimelinePostCreate(TimelinePostBase):
    pass

# Suno 변환 시
class SunoConvertRequest(BaseModel):
    suno_url: str
    title: str
    artist: str
    duration: int
    genre: str

# 업데이트 시
class TimelinePostUpdate(BaseModel):
    content: Optional[str] = None
    media_url: Optional[str] = None

# 응답
class TimelinePostResponse(TimelinePostBase):
    id: int
    user_id: int
    user: Optional[UserResponse] = None
    is_suno_convert: bool
    suno_original_url: Optional[str] = None
    tl_per_second: int
    initial_tl_balance: int
    likes_count: int
    comments_count: int
    plays_count: int
    is_liked: Optional[bool] = False
    created_at: datetime
    updated_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True

# 댓글
class CommentBase(BaseModel):
    content: str

class CommentCreate(CommentBase):
    pass

class CommentResponse(CommentBase):
    id: int
    user_id: int
    user: Optional[UserResponse] = None
    post_id: int
    created_at: datetime
    updated_at: Optional[datetime] = None
    
    class Config:
        from_attributes = True
