from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, update
from app.core.database import get_db
from app.api.v1.endpoints.auth import oauth2_scheme
from app.models.user import User
from app.schemas.user import UserResponse, UserUpdate, TLChargeRequest, TLTransferRequest

router = APIRouter()

async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db)
) -> User:
    """
    현재 로그인한 사용자 조회
    """
    from jose import jwt
    from app.core.config import settings
    
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        user_id: str = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="인증되지 않은 사용자입니다")
    except:
        raise HTTPException(status_code=401, detail="인증되지 않은 사용자입니다")
    
    result = await db.execute(
        select(User).where(User.id == int(user_id))
    )
    user = result.scalar_one_or_none()
    
    if user is None:
        raise HTTPException(status_code=401, detail="사용자를 찾을 수 없습니다")
    
    return user

@router.get("/me", response_model=UserResponse)
async def get_current_user_info(
    current_user: User = Depends(get_current_user)
):
    """
    현재 로그인한 사용자 정보 조회
    """
    return current_user

@router.get("/{user_id}", response_model=UserResponse)
async def get_user(
    user_id: int,
    db: AsyncSession = Depends(get_db)
):
    """
    특정 사용자 정보 조회
    """
    result = await db.execute(
        select(User).where(User.id == user_id)
    )
    user = result.scalar_one_or_none()
    
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다")
    
    return user

@router.patch("/me", response_model=UserResponse)
async def update_user(
    request: UserUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    사용자 정보 수정
    """
    update_data = request.dict(exclude_unset=True)
    
    if update_data:
        await db.execute(
            update(User)
            .where(User.id == current_user.id)
            .values(**update_data)
        )
        await db.commit()
        await db.refresh(current_user)
    
    return current_user

@router.post("/me/charge", response_model=UserResponse)
async def charge_tl(
    request: TLChargeRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    TL 충전
    """
    current_user.tl_balance += request.amount
    
    await db.commit()
    await db.refresh(current_user)
    
    return current_user

@router.post("/me/transfer", response_model=UserResponse)
async def transfer_tl(
    request: TLTransferRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    TL 전송
    """
    if current_user.tl_balance < request.amount:
        raise HTTPException(status_code=400, detail="TL 잔액이 부족합니다")
    
    # 받는 사용자 조회
    result = await db.execute(
        select(User).where(User.id == request.to_user_id)
    )
    to_user = result.scalar_one_or_none()
    
    if not to_user:
        raise HTTPException(status_code=404, detail="받는 사용자를 찾을 수 없습니다")
    
    # TL 전송
    current_user.tl_balance -= request.amount
    to_user.tl_balance += request.amount
    
    await db.commit()
    await db.refresh(current_user)
    
    return current_user
