from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import os

from app.core.config import settings
from app.core.database import create_tables
from app.api.v1.router import api_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    """서버 시작 시 테이블 자동 생성 (개발 환경)"""
    if settings.ENVIRONMENT == "development":
        await create_tables()
        # 업로드 폴더 생성
        os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
        os.makedirs(f"{settings.UPLOAD_DIR}/captures", exist_ok=True)
        os.makedirs(f"{settings.UPLOAD_DIR}/proofs", exist_ok=True)
        os.makedirs(f"{settings.UPLOAD_DIR}/evidence", exist_ok=True)
    yield


app = FastAPI(
    title="TimeLink API",
    description="""
## TimeLink — AI 시대 시간 기반 미디어 경제 플랫폼

### 핵심 기능
- **TL 경제 엔진**: 파일별 TL 잔고, 재생 시 실시간 수익 분배 (70%)
- **인증 시스템**: unverified → pending → review → verified 상태 머신
- **SharePlace**: 인증+공유 파일만 등록 가능
- **이의제기**: 접수 즉시 TL 잠금, 3아웃 계정 몰수
- **POC 기여지수**: -5.0 ~ 10.0, TLC 채굴량 결정
- **차트**: 실시간/신곡/급상승/타입별/글로벌/기여자 랭킹
""",
    version=settings.APP_VERSION,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
    lifespan=lifespan,
)

# ── CORS ──
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.BACKEND_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── API 라우터 ──
app.include_router(api_router, prefix="/api/v1")

# ── 정적 파일 서빙 (업로드) ──
if os.path.exists(settings.UPLOAD_DIR):
    app.mount("/uploads", StaticFiles(directory=settings.UPLOAD_DIR), name="uploads")


@app.get("/")
async def root():
    return {
        "name": "TimeLink API",
        "version": settings.APP_VERSION,
        "environment": settings.ENVIRONMENT,
        "docs": "/api/docs",
        "health": "/api/v1/health",
    }
