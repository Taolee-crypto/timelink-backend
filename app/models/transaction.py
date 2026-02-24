from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, func
from app.core.database import Base


class TxType:
    CHARGE = "charge"           # TL 충전 (파일에)
    DEDUCT = "deduct"           # TL 소비 (재생)
    EARN = "earn"               # 수익 획득 (창작자)
    HOLD = "hold"               # 인증 대기 홀딩
    RELEASE = "release"         # 홀딩 → 수익 확정
    EXCHANGE = "exchange"       # TL → 현금 환전
    LOCK = "lock"               # 이의제기로 잠금
    UNLOCK = "unlock"           # 이의제기 해소 잠금 해제
    FORFEIT = "forfeit"         # 3아웃 몰수
    INITIAL = "initial"         # 가입 보너스
    POC_MINE = "poc_mine"       # TLC 채굴


class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    file_id = Column(Integer, ForeignKey("tl_files.id"), nullable=True)

    tx_type = Column(String, nullable=False)          # TxType 상수
    amount = Column(Float, nullable=False)             # 양수=증가, 음수=감소
    balance_after = Column(Float, nullable=False)      # 거래 후 잔고
    description = Column(String, default="")

    # 상대방 (수익 분배 시)
    counterpart_user_id = Column(Integer, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now(), index=True)
