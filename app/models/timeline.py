from sqlalchemy import Column, Integer, String, ForeignKey, DateTime, Boolean, Text
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from app.core.database import Base

class TimelinePost(Base):
    __tablename__ = "timeline_posts"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    
    # 콘텐츠
    content = Column(Text, nullable=False)
    media_url = Column(String, nullable=True)
    
    # 음원 정보 (Suno 연동)
    is_suno_convert = Column(Boolean, default=False)
    suno_original_url = Column(String, nullable=True)
    suno_song_id = Column(String, nullable=True)
    
    # TL 토큰 정보
    tl_per_second = Column(Integer, default=1)  # 초당 TL 소모율
    initial_tl_balance = Column(Integer, default=0)  # 초기 TL 잔액
    
    # 통계
    likes_count = Column(Integer, default=0)
    comments_count = Column(Integer, default=0)
    plays_count = Column(Integer, default=0)
    
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    
    # 관계
    user = relationship("User", backref="posts")
    likes = relationship("Like", backref="post", cascade="all, delete-orphan")
    comments = relationship("Comment", backref="post", cascade="all, delete-orphan")

class Like(Base):
    __tablename__ = "likes"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    post_id = Column(Integer, ForeignKey("timeline_posts.id"), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class Comment(Base):
    __tablename__ = "comments"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    post_id = Column(Integer, ForeignKey("timeline_posts.id"), nullable=False)
    content = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
