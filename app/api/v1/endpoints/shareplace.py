from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func
from typing import Optional
from app.core.database import get_db
from app.models.tl_file import TLFile, AuthStatus

router = APIRouter()


@router.get("")
async def get_shareplace(
    genre: Optional[str] = Query(None),
    country: Optional[str] = Query(None),
    file_type: Optional[str] = Query(None),
    sort: str = Query("pulse"),
    limit: int = Query(20, le=50),
    offset: int = Query(0),
    db: AsyncSession = Depends(get_db),
):
    q = select(TLFile).where(
        TLFile.auth_status == AuthStatus.verified,
        TLFile.shared == True,
        TLFile.revenue_held == False,
    )
    if genre:
        q = q.where(TLFile.genre == genre)
    if country:
        q = q.where(TLFile.country == country)
    if file_type:
        q = q.where(TLFile.file_type == file_type)
    if sort == "pulse":
        q = q.order_by(desc(TLFile.pulse))
    elif sort == "new":
        q = q.order_by(desc(TLFile.created_at))
    elif sort == "tl":
        q = q.order_by(desc(TLFile.file_tl))
    q = q.offset(offset).limit(limit)
    result = await db.execute(q)
    files = result.scalars().all()
    return [
        {
            "id": f.id,
            "title": f.title,
            "artist": f.artist,
            "genre": f.genre,
            "country": f.country,
            "file_type": f.file_type,
            "file_tl": f.file_tl,
            "pulse": f.pulse,
            "play_count": f.play_count,
            "revenue": f.revenue,
            "auth_status": f.auth_status,
            "created_at": f.created_at,
        }
        for f in files
    ]


@router.get("/contributor-ranking")
async def get_contributor_ranking(
    period: str = Query("weekly"),
    content_type: Optional[str] = Query(None),
    limit: int = Query(20, le=50),
    db: AsyncSession = Depends(get_db),
):
    from datetime import datetime, timedelta
    from sqlalchemy import Float as SAFloat
    from app.models.user import User

    q = (
        select(
            TLFile.user_id,
            func.sum(TLFile.revenue).label("total_revenue"),
            func.sum(TLFile.pulse).label("total_pulse"),
            func.sum(TLFile.play_count).label("total_plays"),
            func.count(TLFile.id).label("verified_tracks"),
        )
        .where(
            TLFile.auth_status == AuthStatus.verified,
            TLFile.shared == True,
        )
        .group_by(TLFile.user_id)
    )

    if period == "weekly":
        cutoff = datetime.utcnow() - timedelta(days=7)
        q = q.where(TLFile.updated_at >= cutoff)
    elif period == "monthly":
        cutoff = datetime.utcnow() - timedelta(days=30)
        q = q.where(TLFile.updated_at >= cutoff)

    q = q.order_by(desc("total_pulse") if period != "alltime" else desc("total_revenue"))
    q = q.limit(limit)

    result = await db.execute(q)
    rows = result.all()

    ranking = []
    for i, row in enumerate(rows):
        user_result = await db.execute(select(User).where(User.id == row.user_id))
        user = user_result.scalar_one_or_none()
        if not user:
            continue
        ranking.append({
            "rank": i + 1,
            "user_id": row.user_id,
            "username": user.username,
            "poc_index": user.poc_index,
            "total_revenue": row.total_revenue or 0,
            "total_pulse": row.total_pulse or 0,
            "total_plays": row.total_plays or 0,
            "verified_tracks": row.verified_tracks or 0,
            "false_dispute_strikes": user.false_dispute_strikes,
            "account_forfeited": user.account_forfeited,
        })
    return ranking
