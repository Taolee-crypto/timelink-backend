from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api.v1.endpoints import users, timeline, auth, health
from app.core.config import settings

app = FastAPI(
    title="Timelink API",
    description="Timelink Platform Backend API - Suno AI 연동",
    version="1.0.0",
    docs_url="/api/docs",
    redoc_url="/api/redoc",
)

# CORS 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.BACKEND_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 라우터 등록
app.include_router(health.router, prefix="/api/health", tags=["health"])
app.include_router(auth.router, prefix="/api/v1/auth", tags=["auth"])
app.include_router(users.router, prefix="/api/v1/users", tags=["users"])
app.include_router(timeline.router, prefix="/api/v1/timeline", tags=["timeline"])

@app.get("/")
async def root():
    return {
        "message": "Timelink API is running",
        "version": "1.0.0",
        "features": ["Suno AI Integration", "TL3/TL4 Tokens", "Car Mode"]
    }
