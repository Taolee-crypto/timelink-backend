"""
POC (Proof of Contribution) 기여지수 엔진
- 범위: -5.0 ~ 10.0
- 기본값: 1.0
- TLC 채굴량 = 소비 TL × 50% × POC 지수 (음수면 채굴 없음)
"""
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.user import User
from app.models.poc_event import POCEvent

POC_MIN = -5.0
POC_MAX = 10.0


async def add_poc(
    db: AsyncSession,
    user: User,
    delta: float,
    reason: str,
) -> POCEvent:
    new_poc = max(POC_MIN, min(POC_MAX, user.poc_index + delta))
    user.poc_index = new_poc

    # TLC 채굴량 업데이트
    if new_poc > 0:
        user.tlc_balance = user.total_tl_spent * 0.5 * new_poc

    event = POCEvent(
        user_id=user.id,
        delta=delta,
        poc_after=new_poc,
        reason=reason,
    )
    db.add(event)
    await db.flush()
    return event


# ── POC 변화 규칙 ──
class POCDelta:
    # 긍정 기여
    AUTH_REQUEST = 0.1          # 인증 신청
    AUTH_VERIFIED = 0.3         # 인증 완료
    SPOTIFY_CLAIM = 0.3         # Spotify 아티스트 인증
    DISPUTE_UPHELD = 0.5        # 이의제기 인용 (정당한 신고)
    LONG_PLAY = 0.05            # 10분 이상 재생 (작성자)

    # 부정 기여
    AUTH_REJECTED = -0.5        # 인증 거부
    DISPUTE_SUBMIT = -0.1       # 이의제기 접수 (결과 전)
    DISPUTE_REJECTED = -2.0     # 허위 이의제기 판정
    CONTENT_REMOVED = -1.0      # 저작권 위반 콘텐츠 제거
