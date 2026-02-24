from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.core.database import get_db
from app.core.security import hash_password, verify_password, create_access_token, create_refresh_token
from app.models.user import User
from app.models.transaction import Transaction, TxType
from app.schemas.user import UserRegister, UserLogin, TokenResponse
from app.core.config import settings

router = APIRouter()


@router.post("/register", response_model=TokenResponse, status_code=201)
async def register(body: UserRegister, db: AsyncSession = Depends(get_db)):
    # 중복 확인
    existing = await db.execute(select(User).where(User.email == body.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Email already registered")

    existing_u = await db.execute(select(User).where(User.username == body.username))
    if existing_u.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Username already taken")

    user = User(
        email=body.email,
        username=body.username,
        password_hash=hash_password(body.password),
        tl_balance=float(settings.TL_INITIAL_BONUS),
        poc_index=1.0,
    )
    db.add(user)
    await db.flush()

    # 가입 보너스 TL 트랜잭션
    tx = Transaction(
        user_id=user.id,
        tx_type=TxType.INITIAL,
        amount=float(settings.TL_INITIAL_BONUS),
        balance_after=float(settings.TL_INITIAL_BONUS),
        description=f"가입 보너스 {settings.TL_INITIAL_BONUS} TL",
    )
    db.add(tx)
    await db.commit()
    await db.refresh(user)

    return TokenResponse(
        access_token=create_access_token(str(user.id)),
        refresh_token=create_refresh_token(str(user.id)),
    )


@router.post("/login", response_model=TokenResponse)
async def login(body: UserLogin, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(User).where(User.email == body.email))
    user = result.scalar_one_or_none()

    if not user or not verify_password(body.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account deactivated")

    return TokenResponse(
        access_token=create_access_token(str(user.id)),
        refresh_token=create_refresh_token(str(user.id)),
    )
