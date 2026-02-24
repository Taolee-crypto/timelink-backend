"""
이의제기 상태 머신 (FSM)
pending → reviewing → resolved_upheld | resolved_rejected

resolved_rejected (기각) → 스트라이크 +1 → 3아웃 시 계정 몰수
resolved_upheld (인용) → 창작자 제재, 이의제기자 TL 해제
"""
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from fastapi import HTTPException
from app.models.dispute import Dispute, DisputeStatus
from app.models.tl_file import TLFile
from app.models.user import User
from app.services.tl_engine import lock_user_tl, unlock_user_tl, forfeit_account
from app.services.poc_engine import add_poc, POCDelta


async def open_dispute(
    db: AsyncSession,
    file: TLFile,
    disputer: User,
    category: str,
    reason: str,
    evidence_paths: list[str] = None,
) -> Dispute:
    """이의제기 접수 - 즉시 TL 잠금 + 수익 분배 중지"""

    if disputer.account_forfeited:
        raise HTTPException(status_code=403, detail="Account forfeited")
    if disputer.tl_suspended:
        raise HTTPException(status_code=400, detail="Already has active dispute")
    if file.user_id == disputer.id:
        raise HTTPException(status_code=400, detail="Cannot dispute own content")

    # 이의제기자 TL 즉시 잠금
    await lock_user_tl(db, disputer)

    # 트랙 수익 분배 중지
    file.revenue_held = True

    import json
    dispute = Dispute(
        file_id=file.id,
        disputer_user_id=disputer.id,
        category=category,
        reason=reason,
        evidence_paths=json.dumps(evidence_paths or []),
        status=DisputeStatus.PENDING,
        days_remaining=30,
    )
    db.add(dispute)

    # POC 소폭 감소 (이의제기 접수 자체)
    await add_poc(db, disputer, POCDelta.DISPUTE_SUBMIT, f"이의제기 접수: file_id={file.id}")

    await db.flush()
    return dispute


async def resolve_dispute(
    db: AsyncSession,
    dispute: Dispute,
    upheld: bool,
    result_note: str,
) -> Dispute:
    """
    심사 결과 처리
    upheld=True: 인용 → 이의제기자 TL 해제, 창작자 콘텐츠 제재
    upheld=False: 기각 → 스트라이크 +1, 3아웃 시 몰수
    """
    dispute.resolved_at = datetime.now(timezone.utc)
    dispute.result_note = result_note

    result = await db.execute(select(User).where(User.id == dispute.disputer_user_id))
    disputer = result.scalar_one_or_none()

    result2 = await db.execute(select(TLFile).where(TLFile.id == dispute.file_id))
    file = result2.scalar_one_or_none()

    result3 = await db.execute(select(User).where(User.id == file.user_id)) if file else None
    creator = result3.scalar_one_or_none() if result3 else None

    if upheld:
        # ── 인용: 이의제기자 승리 ──
        dispute.status = DisputeStatus.UPHELD

        # 이의제기자 TL 해제
        if disputer:
            await unlock_user_tl(db, disputer)
            await add_poc(db, disputer, POCDelta.DISPUTE_UPHELD, "이의제기 인용")

        # 창작자 콘텐츠 제재 (공유 중지)
        if file:
            file.shared = False
            file.revenue_held = True  # 수익 계속 동결
        if creator:
            await add_poc(db, creator, POCDelta.CONTENT_REMOVED, "이의제기 인용으로 콘텐츠 제재")

    else:
        # ── 기각: 허위 이의제기 ──
        dispute.status = DisputeStatus.REJECTED
        dispute.false_strike_added = True

        # 트랙 수익 분배 재개
        if file:
            file.revenue_held = False

        if disputer:
            disputer.false_dispute_strikes += 1
            dispute.poc_delta_applied = POCDelta.DISPUTE_REJECTED
            await add_poc(db, disputer, POCDelta.DISPUTE_REJECTED, f"허위 이의제기 판정 ({disputer.false_dispute_strikes}/3)")

            if disputer.false_dispute_strikes >= 3:
                # 3아웃 — 계정 영구 몰수
                await forfeit_account(db, disputer)
            else:
                # TL 잠금 해제 (스트라이크만 추가)
                await unlock_user_tl(db, disputer)

    await db.flush()
    return dispute
