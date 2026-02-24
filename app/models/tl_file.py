from sqlalchemy import Column, Integer, String, Float, Boolean, DateTime, ForeignKey, func, Enum
from app.core.database import Base
import enum


class AuthStatus(str, enum.Enum):
    unverified = "unverified"   # 업로드 직후
    pending = "pending"          # 증빙 첨부 완료, 심사 대기
    review = "review"            # 심사팀 검토 중
    verified = "verified"        # 인증 완료 → 공유 가능
    rejected = "rejected"        # 인증 거부


class FileType(str, enum.Enum):
    audio = "audio"
    video = "video"


class TLFile(Base):
    __tablename__ = "tl_files"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)

    # ── 메타데이터 ──
    title = Column(String, nullable=False)
    artist = Column(String, default="")
    genre = Column(String, default="")
    country = Column(String, default="kr")
    file_type = Column(String, default="audio")   # audio | video

    # ── 파일 저장 ──
    file_url = Column(String, nullable=False)       # 실제 파일 경로 or S3 URL
    file_size_bytes = Column(Integer, default=0)
    duration_seconds = Column(Integer, default=0)

    # ── TL 경제 (핵심) ──
    file_tl = Column(Float, default=0.0)            # 현재 파일 TL 잔액
    max_file_tl = Column(Float, default=0.0)        # 최초 충전량
    revenue = Column(Float, default=0.0)            # 확정 수익 TL
    hold_revenue = Column(Float, default=0.0)       # 인증 대기 중 홀딩 수익

    # ── 인증 ──
    auth_status = Column(String, default=AuthStatus.unverified)
    auth_type = Column(String, nullable=True)       # manual | suno | udio | spotify
    auth_proof_url = Column(String, nullable=True)  # 원본 AI 플랫폼 URL
    revenue_started_at = Column(DateTime(timezone=True), nullable=True)

    # ── SharePlace ──
    shared = Column(Boolean, default=False)         # VERIFIED만 True 가능
    pulse = Column(Integer, default=0)              # 재생 가중 점수
    play_count = Column(Integer, default=0)

    # ── 분쟁 ──
    revenue_held = Column(Boolean, default=False)   # 이의제기로 수익 중지

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
