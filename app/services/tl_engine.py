"""
TL 경제 엔진
- 모든 TL 이동은 이 모듈을 통해 트랜잭션으로 처리
- 원자성 보장: 한 번의 DB 세션 내에서 처리
"""
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from fastapi import HTTPException, status
from app.models.user import User
from app.models.tl_file import TLFile
from app.models.transaction import Transaction, TxType
from app.models.play_event import PlayEvent
from app.core.config import settings


async def charge_file_tl(
    db: AsyncSession,
    user: User,
    file: TLFile,
    amount: float,
) -> Transaction:
    """파일에 TL 충전 (유저 잔고 → 파일 잔고)"""
    if user.tl_suspended:
        raise HTTPException(status_code=403, detail="TL suspended due to active dispute")
    if user.tl_balance < amount:
        raise HTTPException(status_code=400, detail="Insufficient TL balance")

    user.tl_balance -= amount
    file.file_tl += amount
    file.max_file_tl = max(file.max_file_tl, file.file_tl)

    tx = Transaction(
        user_id=user.id,
        file_id=file.id,
        tx_type=TxType.CHARGE,
        amount=-amount,
        balance_after=user.tl_balance,
        description=f"파일 TL 충전: {file.title}",
    )
    db.add(tx)
    await db.flush()
    return tx


async def process_playback(
    db: AsyncSession,
    file: TLFile,
    player_user_id: int | None,
    duration_seconds: int,
    car_mode: bool = False,
) -> PlayEvent:
    """
    재생 처리: 파일 TL 차감 → 창작자 수익 분배
    - 1초당 1 TL 차감 (기본)
    - Car Mode: 창작자 2배 수익
    - 인증 완료(verified) + 공유 중인 파일만 수익 분배
    """
    if file.file_tl <= 0:
        raise HTTPException(status_code=400, detail="File TL balance depleted")

    # 차감량 계산
    tl_per_second = 1.0
    deduct = min(file.file_tl, duration_seconds * tl_per_second)

    # 수익 분배율
    revenue_rate = settings.REVENUE_SHARE_RATE  # 0.7
    if car_mode:
        revenue_rate = min(1.0, revenue_rate * settings.CAR_MODE_MULTIPLIER)

    revenue = 0.0
    if file.auth_status == "verified" and not file.revenue_held:
        revenue = deduct * revenue_rate

    # 파일 TL 차감
    file.file_tl -= deduct
    file.play_count += 1
    file.pulse += max(1, int(duration_seconds / 10))

    # 창작자 수익 기록
    if revenue > 0:
        # 창작자 조회
        result = await db.execute(select(User).where(User.id == file.user_id))
        creator = result.scalar_one_or_none()
        if creator:
            if file.auth_status == "verified":
                creator.tl_balance += revenue
                creator.total_tl_earned += revenue
                file.revenue += revenue

                creator_tx = Transaction(
                    user_id=creator.id,
                    file_id=file.id,
                    tx_type=TxType.EARN,
                    amount=revenue,
                    balance_after=creator.tl_balance,
                    description=f"재생 수익: {file.title} ({duration_seconds}초)",
                    counterpart_user_id=player_user_id,
                )
                db.add(creator_tx)
            else:
                # 미인증 → 홀딩
                file.hold_revenue += revenue
                creator_tx = Transaction(
                    user_id=creator.id,
                    file_id=file.id,
                    tx_type=TxType.HOLD,
                    amount=revenue,
                    balance_after=creator.tl_balance,
                    description=f"홀딩 수익 (인증 대기): {file.title}",
                )
                db.add(creator_tx)

    # 플레이어 소비 기록
    if player_user_id:
        result = await db.execute(select(User).where(User.id == player_user_id))
        player = result.scalar_one_or_none()
        if player:
            player.total_tl_spent += deduct

    event = PlayEvent(
        file_id=file.id,
        player_user_id=player_user_id,
        tl_deducted=deduct,
        revenue_credited=revenue,
        file_tl_after=file.file_tl,
        play_duration_seconds=duration_seconds,
        car_mode=car_mode,
    )
    db.add(event)
    await db.flush()
    return event


async def release_hold_revenue(db: AsyncSession, file: TLFile):
    """인증 완료 시 홀딩 수익 → 창작자 확정 수익으로 이전"""
    if file.hold_revenue <= 0:
        return

    result = await db.execute(select(User).where(User.id == file.user_id))
    creator = result.scalar_one_or_none()
    if not creator:
        return

    amount = file.hold_revenue
    creator.tl_balance += amount
    creator.total_tl_earned += amount
    file.revenue += amount
    file.hold_revenue = 0.0
    file.revenue_started_at = __import__("datetime").datetime.utcnow()

    tx = Transaction(
        user_id=creator.id,
        file_id=file.id,
        tx_type=TxType.RELEASE,
        amount=amount,
        balance_after=creator.tl_balance,
        description=f"홀딩 수익 해제 (인증 완료): {file.title}",
    )
    db.add(tx)
    await db.flush()


async def lock_user_tl(db: AsyncSession, user: User):
    """이의제기 접수 시 전체 TL 잠금"""
    user.tl_locked = user.tl_balance
    user.tl_balance = 0.0
    user.tl_suspended = True

    tx = Transaction(
        user_id=user.id,
        tx_type=TxType.LOCK,
        amount=-user.tl_locked,
        balance_after=0.0,
        description="이의제기 접수로 TL 잠금",
    )
    db.add(tx)
    await db.flush()


async def unlock_user_tl(db: AsyncSession, user: User):
    """이의제기 해소 시 TL 잠금 해제"""
    user.tl_balance = user.tl_locked
    user.tl_locked = 0.0
    user.tl_suspended = False

    tx = Transaction(
        user_id=user.id,
        tx_type=TxType.UNLOCK,
        amount=user.tl_balance,
        balance_after=user.tl_balance,
        description="이의제기 해소로 TL 잠금 해제",
    )
    db.add(tx)
    await db.flush()


async def forfeit_account(db: AsyncSession, user: User):
    """3아웃 - 계정 몰수 (TL + TLC 전액)"""
    forfeited_tl = user.tl_balance + user.tl_locked
    forfeited_tlc = user.tlc_balance

    tx = Transaction(
        user_id=user.id,
        tx_type=TxType.FORFEIT,
        amount=-(forfeited_tl),
        balance_after=0.0,
        description=f"3아웃 계정 몰수: TL {forfeited_tl:.0f} + TLC {forfeited_tlc:.4f}",
    )
    db.add(tx)

    user.tl_balance = 0.0
    user.tl_locked = 0.0
    user.tlc_balance = 0.0
    user.account_forfeited = True
    user.tl_suspended = True

    await db.flush()
