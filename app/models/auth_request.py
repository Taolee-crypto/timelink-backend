from sqlalchemy import Column, Integer, String, Boolean, DateTime, ForeignKey, Text, func
from app.core.database import Base


class AuthRequest(Base):
    __tablename__ = "auth_requests"

    id = Column(Integer, primary_key=True, index=True)
    file_id = Column(Integer, ForeignKey("tl_files.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)

    # ── 제출 데이터 ──
    source_url = Column(String, nullable=True)          # AI 플랫폼 음원 URL
    profile_url = Column(String, nullable=True)         # 계정 프로필 URL
    capture_path = Column(String, nullable=True)        # 생성 화면 캡처 (날짜+시간+계정명)
    payment_proof_path = Column(String, nullable=True)  # 결제 영수증
    email_proof = Column(String, nullable=True)         # 결제 이메일
    plan_type = Column(String, nullable=True)           # Basic | Pro | Premier
    creation_month = Column(String, nullable=True)      # 음원 생성 월 (YYYY-MM)
    extra_notes = Column(Text, nullable=True)

    # ── 심사 ──
    status = Column(String, default="pending")          # pending|reviewing|approved|rejected
    ocr_result = Column(Text, nullable=True)            # JSON 문자열
    reviewer_note = Column(Text, nullable=True)
    reviewed_by = Column(Integer, nullable=True)        # 관리자 user_id

    # ── 시간 ──
    submitted_at = Column(DateTime(timezone=True), server_default=func.now())
    reviewed_at = Column(DateTime(timezone=True), nullable=True)
