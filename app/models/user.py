from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, func
from app.core.database import Base


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    username = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)

    # ── TL 경제 ──
    tl_balance = Column(Float, default=0.0, nullable=False)       # 현재 사용 가능한 TL
    tl_locked = Column(Float, default=0.0, nullable=False)        # 이의제기로 잠긴 TL
    tlc_balance = Column(Float, default=0.0, nullable=False)      # TLC 채굴량

    # 누적 통계 (환전 계산용)
    total_tl_spent = Column(Float, default=0.0, nullable=False)   # 누적 소비 TL
    total_tl_earned = Column(Float, default=0.0, nullable=False)  # 누적 수익 TL
    total_tl_exchanged = Column(Float, default=0.0, nullable=False)  # 누적 환전 TL

    # ── POC 기여지수 ──
    poc_index = Column(Float, default=1.0, nullable=False)        # -5.0 ~ 10.0

    # ── 3아웃 시스템 ──
    false_dispute_strikes = Column(Integer, default=0, nullable=False)
    account_forfeited = Column(Boolean, default=False, nullable=False)
    tl_suspended = Column(Boolean, default=False, nullable=False)  # 이의제기 중 정지

    # ── 기타 ──
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    @property
    def exchangeable_tl(self) -> float:
        """환전 가능량 = (소비 TL - 환전 TL) × 50%"""
        available = (self.total_tl_spent - self.total_tl_exchanged) * 0.5
        return max(0.0, available)

    @property
    def tlc_mineable(self) -> float:
        """TLC 채굴량 = 소비 TL × 50% × POC 지수"""
        if self.poc_index <= 0:
            return 0.0
        return self.total_tl_spent * 0.5 * self.poc_index
