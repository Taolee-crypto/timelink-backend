import json
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from typing import Optional
from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.core.config import settings
from app.models.user import User
from app.models.tl_file import TLFile
from app.models.dispute import Dispute, DisputeStatus
from app.schemas.dispute import DisputeCreate, DisputeResolve, DisputeOut
from app.services.dispute_fsm import open_dispute, resolve_dispute
import os, aiofiles, time

router = APIRouter()


@router.post("", response_model=DisputeOut, status_code=201)
async def create_dispute(
    file_id: int = Form(...),
    category: str = Form(...),
    reason: str = Form(...),
    evidence1: Optional[UploadFile] = File(None),
    evidence2: Optional[UploadFile] = File(None),
    evidence3: Optional[UploadFile] = File(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    이의제기 접수
    - 접수 즉시: 이의제기자 TL 전액 잠금 + 창작자 수익 분배 중지
    - 30일 내 심사팀 처리
    """
    if len(reason) < 50:
        raise HTTPException(status_code=400, detail="Reason must be at least 50 characters")
    if category not in {"copyright", "fake", "abuse", "other"}:
        raise HTTPException(status_code=400, detail="Invalid category")

    file_result = await db.execute(select(TLFile).where(TLFile.id == file_id))
    tl_file = file_result.scalar_one_or_none()
    if not tl_file:
        raise HTTPException(status_code=404, detail="File not found")

    # 증거 파일 저장
    evidence_paths = []
    evidence_dir = os.path.join(settings.UPLOAD_DIR, "evidence")
    os.makedirs(evidence_dir, exist_ok=True)

    for ev in [evidence1, evidence2, evidence3]:
        if ev:
            content = await ev.read()
            ext = os.path.splitext(ev.filename or "ev")[1] or ".jpg"
            fname = f"ev_{current_user.id}_{file_id}_{int(time.time())}{ext}"
            fpath = os.path.join(evidence_dir, fname)
            async with aiofiles.open(fpath, "wb") as f:
                await f.write(content)
            evidence_paths.append(fpath)

    dispute = await open_dispute(
        db=db,
        file=tl_file,
        disputer=current_user,
        category=category,
        reason=reason,
        evidence_paths=evidence_paths,
    )
    await db.commit()
    await db.refresh(dispute)
    return dispute


@router.get("/my", response_model=list[DisputeOut])
async def get_my_disputes(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(Dispute)
        .where(Dispute.disputer_user_id == current_user.id)
        .order_by(desc(Dispute.created_at))
    )
    return result.scalars().all()


@router.get("/{dispute_id}", response_model=DisputeOut)
async def get_dispute(
    dispute_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(Dispute).where(Dispute.id == dispute_id))
    dispute = result.scalar_one_or_none()
    if not dispute:
        raise HTTPException(status_code=404, detail="Dispute not found")
    if dispute.disputer_user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Access denied")
    return dispute


@router.post("/{dispute_id}/resolve", response_model=DisputeOut)
async def resolve(
    dispute_id: int,
    body: DisputeResolve,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    관리자 심사 결과 처리 (추후 admin role 검증 추가)
    upheld=True → 인용 (이의제기자 승리)
    upheld=False → 기각 (허위 이의제기 → 스트라이크 +1)
    """
    result = await db.execute(select(Dispute).where(Dispute.id == dispute_id))
    dispute = result.scalar_one_or_none()
    if not dispute:
        raise HTTPException(status_code=404, detail="Dispute not found")
    if dispute.status not in (DisputeStatus.PENDING, DisputeStatus.REVIEWING):
        raise HTTPException(status_code=400, detail="Dispute already resolved")

    dispute = await resolve_dispute(
        db=db,
        dispute=dispute,
        upheld=body.upheld,
        result_note=body.result_note,
    )
    await db.commit()
    await db.refresh(dispute)
    return dispute
