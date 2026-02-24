from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, ForeignKey, Text, func
from app.core.database import Base


class DisputeStatus:
    PENDING = "pending"
    REVIEWING = "reviewing"
    UPHELD = "resolved_upheld"      # 인용 - 이의제기자 승리
    REJECTED = "resolved_rejected"  # 기각 - 허위 이의제기


class DisputeCategory:
    COPYRIGHT = "copyright"   # 저작권 침해
    FAKE = "fake"             # 허위 인증
    ABUSE = "abuse"           # 어뷰징 의심
    OTHER = "other"           # 기타


class Dispute(Base):
    __tablename__ = "disputes"

    id = Column(Integer, primary_key=True, index=True)
    file_id = Column(Integer, ForeignKey("tl_files.id"), nullable=False, index=True)
    disputer_user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)

    # ── 내용 ──
    category = Column(String, nullable=False)       # DisputeCategory
    reason = Column(Text, nullable=False)
    evidence_paths = Column(Text, default="[]")     # JSON array of file paths

    # ── 상태 ──
    status = Column(String, default=DisputeStatus.PENDING)
    result_note = Column(Text, nullable=True)
    days_remaining = Column(Integer, default=30)

    # ── 처리 결과 ──
    false_strike_added = Column(Boolean, default=False)  # 허위 판정 시 True
    poc_delta_applied = Column(Float, default=0.0)       # 적용된 POC 변화량

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    resolved_at = Column(DateTime(timezone=True), nullable=True)
