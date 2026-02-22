from fastapi import APIRouter, HTTPException, Depends
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.core.database import get_db
from app.core.security import create_access_token, verify_password, get_password_hash
from app.models.user import User
from app.schemas.auth import LoginRequest, SignupRequest, TokenResponse

router = APIRouter()
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")

@router.post("/login", response_model=TokenResponse)
async def login(
    request: LoginRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    사용자 로그인
    """
    # 사용자 조회
    result = await db.execute(
        select(User).where(User.email == request.email)
    )
    user = result.scalar_one_or_none()
    
    if not user or not verify_password(request.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="이메일 또는 비밀번호가 올바르지 않습니다")
    
    # 토큰 생성
    access_token = create_access_token(subject=user.id)
    
    return {
        "access_token": access_token,
        "token_type": "bearer"
    }

@router.post("/signup", response_model=TokenResponse)
async def signup(
    request: SignupRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    회원가입
    """
    # 이메일 중복 확인
    result = await db.execute(
        select(User).where(User.email == request.email)
    )
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="이미 사용중인 이메일입니다")
    
    # 사용자명 중복 확인
    result = await db.execute(
        select(User).where(User.username == request.username)
    )
    if result.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="이미 사용중인 사용자명입니다")
    
    # 사용자 생성
    user = User(
        email=request.email,
        username=request.username,
        hashed_password=get_password_hash(request.password),
        tl_balance=10000,  # 초기 TL 지급
    )
    
    db.add(user)
    await db.commit()
    await db.refresh(user)
    
    # 토큰 생성
    access_token = create_access_token(subject=user.id)
    
    return {
        "access_token": access_token,
        "token_type": "bearer"
    }

@router.post("/logout")
async def logout():
    """
    로그아웃 (클라이언트에서 토큰 삭제)
    """
    return {"message": "Logged out successfully"}
