from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.models.user import User
from app.models.transaction import Transaction
from app.models.poc_event import POCEvent
from app.schemas.user import UserOut, WalletSummary

router = APIRouter()


@router.get("/me", response_model=UserOut)
async def get_me(current_user: User = Depends(get_current_user)):
    return current_user


@router.get("/me/wallet", response_model=WalletSummary)
async def get_wallet(current_user: User = Depends(get_current_user)):
    return WalletSummary(
        tl_balance=current_user.tl_balance,
        tl_locked=current_user.tl_locked,
        tlc_balance=current_user.tlc_balance,
        total_tl_spent=current_user.total_tl_spent,
        total_tl_earned=current_user.total_tl_earned,
        total_tl_exchanged=current_user.total_tl_exchanged,
        exchangeable_tl=current_user.exchangeable_tl,
        poc_index=current_user.poc_index,
        tl_suspended=current_user.tl_suspended,
        false_dispute_strikes=current_user.false_dispute_strikes,
        account_forfeited=current_user.account_forfeited,
    )


@router.get("/me/transactions")
async def get_transactions(
    limit: int = 20,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Transaction)
        .where(Transaction.user_id == current_user.id)
        .order_by(desc(Transaction.created_at))
        .offset(offset)
        .limit(limit)
    )
    txs = result.scalars().all()
    return [
        {
            "id": t.id,
            "tx_type": t.tx_type,
            "amount": t.amount,
            "balance_after": t.balance_after,
            "description": t.description,
            "file_id": t.file_id,
            "created_at": t.created_at,
        }
        for t in txs
    ]


@router.get("/me/poc-history")
async def get_poc_history(
    limit: int = 10,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(POCEvent)
        .where(POCEvent.user_id == current_user.id)
        .order_by(desc(POCEvent.created_at))
        .limit(limit)
    )
    events = result.scalars().all()
    return [
        {
            "id": e.id,
            "delta": e.delta,
            "poc_after": e.poc_after,
            "reason": e.reason,
            "created_at": e.created_at,
        }
        for e in events
    ]
