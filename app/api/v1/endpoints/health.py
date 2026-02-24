from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text
from app.core.database import get_db
from app.core.config import settings

router = APIRouter()


@router.get("")
async def health_check(db: AsyncSession = Depends(get_db)):
    try:
        await db.execute(text("SELECT 1"))
        db_status = "ok"
    except Exception as e:
        db_status = f"error: {str(e)}"

    return {
        "status": "ok",
        "version": settings.APP_VERSION,
        "environment": settings.ENVIRONMENT,
        "database": db_status,
        "endpoints": {
            "auth": "/api/v1/auth",
            "users": "/api/v1/users",
            "files": "/api/v1/files",
            "playback": "/api/v1/playback",
            "shareplace": "/api/v1/shareplace",
            "disputes": "/api/v1/disputes",
            "charts": "/api/v1/charts",
        },
    }
