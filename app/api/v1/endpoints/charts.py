from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc, func
from datetime import datetime, timedelta
from typing import Optional
from app.core.database import get_db
from app.models.tl_file import TLFile, AuthStatus

router = APIRouter()

CHART_LIMIT = 100   # 최대 100위까지


def _file_to_chart_item(f: TLFile, rank: int) -> dict:
    return {
        "rank": rank,
        "id": f.id,
        "title": f.title,
        "artist": f.artist,
        "genre": f.genre,
        "country": f.country,
        "file_type": f.file_type,
        "tl": f.file_tl,
        "pulse": f.pulse,
        "plays": f.play_count,
        "auth_status": f.auth_status,
    }


@router.get("/hot")
async def chart_hot(
    limit: int = Query(20, le=CHART_LIMIT),
    db: AsyncSession = Depends(get_db),
):
    """실시간 차트 — Pulse 기준 (공유 중인 verified 파일)"""
    result = await db.execute(
        select(TLFile)
        .where(TLFile.auth_status == AuthStatus.verified, TLFile.shared == True)
        .order_by(desc(TLFile.pulse))
        .limit(limit)
    )
    files = result.scalars().all()
    return [_file_to_chart_item(f, i + 1) for i, f in enumerate(files)]


@router.get("/new")
async def chart_new(
    limit: int = Query(20, le=CHART_LIMIT),
    db: AsyncSession = Depends(get_db),
):
    """신곡 차트 — 최근 7일 내 공유된 파일"""
    cutoff = datetime.utcnow() - timedelta(days=7)
    result = await db.execute(
        select(TLFile)
        .where(
            TLFile.auth_status == AuthStatus.verified,
            TLFile.shared == True,
            TLFile.created_at >= cutoff,
        )
        .order_by(desc(TLFile.pulse))
        .limit(limit)
    )
    files = result.scalars().all()
    return [_file_to_chart_item(f, i + 1) for i, f in enumerate(files)]


@router.get("/rise")
async def chart_rise(
    limit: int = Query(20, le=CHART_LIMIT),
    db: AsyncSession = Depends(get_db),
):
    """급상승 차트 — 24h 내 play_count 급증"""
    cutoff = datetime.utcnow() - timedelta(hours=24)
    from app.models.play_event import PlayEvent
    from sqlalchemy import Integer

    # 24h 재생 수 집계
    sub = (
        select(
            PlayEvent.file_id,
            func.count(PlayEvent.id).label("recent_plays"),
        )
        .where(PlayEvent.created_at >= cutoff)
        .group_by(PlayEvent.file_id)
        .subquery()
    )

    result = await db.execute(
        select(TLFile, sub.c.recent_plays)
        .join(sub, TLFile.id == sub.c.file_id)
        .where(TLFile.auth_status == AuthStatus.verified, TLFile.shared == True)
        .order_by(desc(sub.c.recent_plays))
        .limit(limit)
    )
    rows = result.all()
    return [
        {**_file_to_chart_item(row[0], i + 1), "recent_plays_24h": row[1]}
        for i, row in enumerate(rows)
    ]


@router.get("/by-type")
async def chart_by_type(
    file_type: str = Query("audio"),   # audio | video | lecture
    country: Optional[str] = Query(None),
    limit: int = Query(20, le=CHART_LIMIT),
    db: AsyncSession = Depends(get_db),
):
    """타입별 차트 — 음악/영상/강의"""
    q = select(TLFile).where(
        TLFile.auth_status == AuthStatus.verified,
        TLFile.shared == True,
        TLFile.file_type == file_type,
    )
    if country:
        q = q.where(TLFile.country == country)
    q = q.order_by(desc(TLFile.pulse)).limit(limit)

    result = await db.execute(q)
    files = result.scalars().all()
    return [_file_to_chart_item(f, i + 1) for i, f in enumerate(files)]


@router.get("/global")
async def chart_global(
    limit: int = Query(20, le=CHART_LIMIT),
    db: AsyncSession = Depends(get_db),
):
    """글로벌 차트 — 전체 국가 통합 Pulse 순위"""
    result = await db.execute(
        select(TLFile)
        .where(TLFile.auth_status == AuthStatus.verified, TLFile.shared == True)
        .order_by(desc(TLFile.pulse))
        .limit(limit)
    )
    files = result.scalars().all()
    return [_file_to_chart_item(f, i + 1) for i, f in enumerate(files)]
