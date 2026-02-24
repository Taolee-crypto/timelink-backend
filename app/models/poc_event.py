from sqlalchemy import Column, Integer, Float, String, DateTime, ForeignKey, func
from app.core.database import Base


class POCEvent(Base):
    __tablename__ = "poc_events"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)

    delta = Column(Float, nullable=False)        # 변화량 (양수/음수)
    poc_after = Column(Float, nullable=False)    # 적용 후 POC 지수
    reason = Column(String, nullable=False)      # 사유 설명

    created_at = Column(DateTime(timezone=True), server_default=func.now())
