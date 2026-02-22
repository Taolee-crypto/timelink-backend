from sqlalchemy import Column, Integer, String, Float, DateTime, Boolean
from sqlalchemy.sql import func
from app.core.database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    username = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)
    
    # 프로필
    bio = Column(String, nullable=True)
    profile_image = Column(String, nullable=True)
    
    # TL 토큰
    tl_balance = Column(Integer, default=10000)  # 사용 가능 TL
    tl_locked = Column(Integer, default=0)       # 잠긴 TL
    
    # 신뢰 점수 시스템
    trust_score = Column(Float, default=1.0)      # Trust (0.8-1.2)
    lvs_score = Column(Float, default=1.0)        # Listening Validity Score (0.5-1.0)
    total_listened = Column(Integer, default=0)   # 총 청취 시간(초)
    
    # 설정
    car_mode_enabled = Column(Boolean, default=False)
    auto_recharge_enabled = Column(Boolean, default=True)
    auto_recharge_threshold = Column(Integer, default=2000)
    auto_recharge_amount = Column(Integer, default=5000)
    
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
