from fastapi import APIRouter
from app.api.v1.endpoints import (
    auth, users, files, playback, shareplace, disputes, charts, health
)

api_router = APIRouter()

api_router.include_router(health.router,      prefix="/health",     tags=["health"])
api_router.include_router(auth.router,        prefix="/auth",       tags=["auth"])
api_router.include_router(users.router,       prefix="/users",      tags=["users"])
api_router.include_router(files.router,       prefix="/files",      tags=["files"])
api_router.include_router(playback.router,    prefix="/playback",   tags=["playback"])
api_router.include_router(shareplace.router,  prefix="/shareplace", tags=["shareplace"])
api_router.include_router(disputes.router,    prefix="/disputes",   tags=["disputes"])
api_router.include_router(charts.router,      prefix="/charts",     tags=["charts"])
