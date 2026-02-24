import os
import aiofiles
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from typing import Optional
from app.core.database import get_db
from app.core.dependencies import get_current_user
from app.core.config import settings
from app.models.user import User
from app.models.tl_file import TLFile, AuthStatus
from app.models.auth_request import AuthRequest
from app.schemas.file import FileOut, FileShare, TLChargeRequest
from app.services.tl_engine import charge_file_tl, release_hold_revenue
from app.services.poc_engine import add_poc, POCDelta
from app.services.ocr_service import verify_ai_content

router = APIRouter()

os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
os.makedirs(f"{settings.UPLOAD_DIR}/captures", exist_ok=True)
os.makedirs(f"{settings.UPLOAD_DIR}/proofs", exist_ok=True)


# ── 파일 업로드 ──
@router.post("/upload", response_model=FileOut, status_code=201)
async def upload_file(
    title: str = Form(...),
    artist: str = Form(""),
    genre: str = Form(""),
    country: str = Form("kr"),
    file_tl: float = Form(1000.0),
    audio_file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """음원/영상 파일 업로드 — 업로드 직후 authStatus=unverified, 공유 불가"""
    if current_user.tl_balance < file_tl:
        raise HTTPException(status_code=400, detail="Insufficient TL balance")

    # 파일 크기 확인
    content = await audio_file.read()
    size_mb = len(content) / (1024 * 1024)
    if size_mb > settings.MAX_FILE_SIZE_MB:
        raise HTTPException(status_code=413, detail=f"File too large (max {settings.MAX_FILE_SIZE_MB}MB)")

    # 파일 저장
    ext = os.path.splitext(audio_file.filename or "file")[1] or ".mp3"
    fname = f"{current_user.id}_{int(__import__('time').time())}{ext}"
    fpath = os.path.join(settings.UPLOAD_DIR, fname)
    async with aiofiles.open(fpath, "wb") as f:
        await f.write(content)

    file_type = "video" if audio_file.content_type and "video" in audio_file.content_type else "audio"

    tl_file = TLFile(
        user_id=current_user.id,
        title=title,
        artist=artist,
        genre=genre,
        country=country,
        file_type=file_type,
        file_url=fpath,
        file_size_bytes=len(content),
        auth_status=AuthStatus.unverified,
        shared=False,
        file_tl=0.0,
        max_file_tl=0.0,
    )
    db.add(tl_file)
    await db.flush()

    # TL 충전 (유저 잔고 → 파일 잔고)
    await charge_file_tl(db, current_user, tl_file, file_tl)
    await db.commit()
    await db.refresh(tl_file)
    return tl_file


# ── 내 파일 목록 ──
@router.get("/my", response_model=list[FileOut])
async def get_my_files(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(TLFile)
        .where(TLFile.user_id == current_user.id)
        .order_by(desc(TLFile.created_at))
    )
    return result.scalars().all()


# ── 단일 파일 조회 ──
@router.get("/{file_id}", response_model=FileOut)
async def get_file(
    file_id: int,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(TLFile).where(TLFile.id == file_id))
    f = result.scalar_one_or_none()
    if not f:
        raise HTTPException(status_code=404, detail="File not found")
    return f


# ── 파일 TL 추가 충전 ──
@router.post("/{file_id}/charge")
async def charge_file(
    file_id: int,
    body: TLChargeRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(TLFile).where(TLFile.id == file_id, TLFile.user_id == current_user.id))
    tl_file = result.scalar_one_or_none()
    if not tl_file:
        raise HTTPException(status_code=404, detail="File not found or not yours")

    await charge_file_tl(db, current_user, tl_file, body.amount)
    await db.commit()
    return {"file_tl": tl_file.file_tl, "tl_balance": current_user.tl_balance}


# ── 인증 신청 (직접 업로드 파일) ──
@router.post("/{file_id}/auth-request", status_code=201)
async def request_auth(
    file_id: int,
    source_url: str = Form(...),
    profile_url: Optional[str] = Form(None),
    plan_type: Optional[str] = Form(None),
    creation_month: Optional[str] = Form(None),
    email_proof: Optional[str] = Form(None),
    extra_notes: Optional[str] = Form(None),
    capture: Optional[UploadFile] = File(None),
    payment_proof: Optional[UploadFile] = File(None),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """인증 신청 — 증빙 첨부 → OCR 분석 → pending/review"""
    result = await db.execute(
        select(TLFile).where(TLFile.id == file_id, TLFile.user_id == current_user.id)
    )
    tl_file = result.scalar_one_or_none()
    if not tl_file:
        raise HTTPException(status_code=404, detail="File not found")
    if tl_file.auth_status == AuthStatus.verified:
        raise HTTPException(status_code=400, detail="Already verified")

    # 파일 저장
    capture_path = None
    payment_path = None

    if capture:
        cap_content = await capture.read()
        cap_name = f"cap_{current_user.id}_{file_id}_{int(__import__('time').time())}.jpg"
        capture_path = os.path.join(settings.UPLOAD_DIR, "captures", cap_name)
        async with aiofiles.open(capture_path, "wb") as f:
            await f.write(cap_content)

    if payment_proof:
        pay_content = await payment_proof.read()
        pay_ext = os.path.splitext(payment_proof.filename or "proof")[1] or ".jpg"
        pay_name = f"proof_{current_user.id}_{file_id}_{int(__import__('time').time())}{pay_ext}"
        payment_path = os.path.join(settings.UPLOAD_DIR, "proofs", pay_name)
        async with aiofiles.open(payment_path, "wb") as f:
            await f.write(pay_content)

    # OCR 분석
    ocr_result = await verify_ai_content(
        source_url=source_url,
        profile_url=profile_url,
        capture_path=capture_path,
        payment_proof_path=payment_path,
        plan_type=plan_type,
        creation_month=creation_month,
    )

    # 인증 신청 기록
    auth_req = AuthRequest(
        file_id=file_id,
        user_id=current_user.id,
        source_url=source_url,
        profile_url=profile_url,
        capture_path=capture_path,
        payment_proof_path=payment_path,
        email_proof=email_proof,
        plan_type=plan_type,
        creation_month=creation_month,
        extra_notes=extra_notes,
        status="reviewing" if ocr_result.passed else "pending",
        ocr_result=ocr_result.to_json(),
    )
    db.add(auth_req)

    # 파일 상태 업데이트
    tl_file.auth_status = AuthStatus.review if ocr_result.passed else AuthStatus.pending
    tl_file.auth_proof_url = source_url

    # POC 기여
    await add_poc(db, current_user, POCDelta.AUTH_REQUEST, f"인증 신청: {tl_file.title}")

    await db.commit()
    return {
        "ocr_passed": ocr_result.passed,
        "auth_status": tl_file.auth_status,
        "checks": ocr_result.checks,
        "note": ocr_result.note,
    }


# ── 공유 설정 (VERIFIED 만 가능) ──
@router.patch("/{file_id}/share")
async def set_share(
    file_id: int,
    body: FileShare,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(
        select(TLFile).where(TLFile.id == file_id, TLFile.user_id == current_user.id)
    )
    tl_file = result.scalar_one_or_none()
    if not tl_file:
        raise HTTPException(status_code=404, detail="File not found")
    if body.shared and tl_file.auth_status != AuthStatus.verified:
        raise HTTPException(status_code=403, detail="Only verified files can be shared")

    tl_file.shared = body.shared
    await db.commit()
    return {"shared": tl_file.shared, "file_id": file_id}


# ── 관리자: 인증 승인/거부 ──
@router.post("/{file_id}/approve")
async def approve_file(
    file_id: int,
    approved: bool = True,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """관리자 심사 결과 처리 (추후 admin role 확인 추가)"""
    result = await db.execute(select(TLFile).where(TLFile.id == file_id))
    tl_file = result.scalar_one_or_none()
    if not tl_file:
        raise HTTPException(status_code=404, detail="File not found")

    owner_result = await db.execute(select(User).where(User.id == tl_file.user_id))
    owner = owner_result.scalar_one_or_none()

    if approved:
        tl_file.auth_status = AuthStatus.verified
        # 홀딩 수익 해제
        await release_hold_revenue(db, tl_file)
        if owner:
            await add_poc(db, owner, POCDelta.AUTH_VERIFIED, f"인증 완료: {tl_file.title}")
    else:
        tl_file.auth_status = AuthStatus.rejected
        if owner:
            await add_poc(db, owner, POCDelta.AUTH_REJECTED, f"인증 거부: {tl_file.title}")

    await db.commit()
    return {"auth_status": tl_file.auth_status, "file_id": file_id}
