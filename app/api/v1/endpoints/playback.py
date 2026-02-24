from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from pydantic import BaseModel
from typing import Optional
from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.models.user import User
from app.models.tl_file import TLFile
from app.services.tl_engine import process_playback

router = APIRouter()


class PlayRequest(BaseModel):
    duration_seconds: int = 30
    car_mode: bool = False


@router.post("/{file_id}/play")
async def play_file(
    file_id: int,
    body: PlayRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Optional[User] = Depends(get_current_user),
):
    """
    재생 이벤트 처리
    - 파일 TL 차감
    - 인증된 파일: 즉시 창작자 수익 분배 (70%)
    - 미인증 파일: 홀딩 수익 적립
    - Car Mode: 창작자 2배 수익
    - 잔액 0 → 재생 불가
    """
    result = await db.execute(select(TLFile).where(TLFile.id == file_id))
    tl_file = result.scalar_one_or_none()
    if not tl_file:
        raise HTTPException(status_code=404, detail="File not found")
    if tl_file.file_tl <= 0:
        raise HTTPException(status_code=402, detail="File TL depleted — owner must recharge")
    if tl_file.revenue_held:
        raise HTTPException(status_code=403, detail="File is under dispute review")

    player_id = current_user.id if current_user else None
    event = await process_playback(
        db=db,
        file=tl_file,
        player_user_id=player_id,
        duration_seconds=body.duration_seconds,
        car_mode=body.car_mode,
    )
    await db.commit()

    return {
        "tl_deducted": event.tl_deducted,
        "revenue_credited": event.revenue_credited,
        "file_tl_remaining": event.file_tl_after,
        "play_count": tl_file.play_count,
        "car_mode": body.car_mode,
    }


@router.get("/{file_id}/status")
async def get_file_status(
    file_id: int,
    db: AsyncSession = Depends(get_db),
):
    """재생 전 파일 TL 상태 확인"""
    result = await db.execute(select(TLFile).where(TLFile.id == file_id))
    tl_file = result.scalar_one_or_none()
    if not tl_file:
        raise HTTPException(status_code=404, detail="File not found")

    return {
        "file_id": file_id,
        "title": tl_file.title,
        "file_tl": tl_file.file_tl,
        "playable": tl_file.file_tl > 0 and not tl_file.revenue_held,
        "auth_status": tl_file.auth_status,
        "revenue_held": tl_file.revenue_held,
    }
