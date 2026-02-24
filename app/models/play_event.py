from sqlalchemy import Column, Integer, Float, Boolean, DateTime, ForeignKey, func
from app.core.database import Base


class PlayEvent(Base):
    __tablename__ = "play_events"

    id = Column(Integer, primary_key=True, index=True)
    file_id = Column(Integer, ForeignKey("tl_files.id"), nullable=False, index=True)
    player_user_id = Column(Integer, ForeignKey("users.id"), nullable=True)  # 비로그인 허용

    # ── TL 흐름 ──
    tl_deducted = Column(Float, default=0.0)       # 파일 TL에서 차감된 양
    revenue_credited = Column(Float, default=0.0)  # 창작자에게 지급된 수익
    file_tl_after = Column(Float, default=0.0)     # 차감 후 파일 TL 잔액

    # ── 재생 정보 ──
    play_duration_seconds = Column(Integer, default=0)
    car_mode = Column(Boolean, default=False)       # Car Mode → 2x 보상

    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
