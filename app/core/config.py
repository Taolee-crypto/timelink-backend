from typing import List, Optional
from pydantic_settings import BaseSettings
from pydantic import AnyHttpUrl, validator

class Settings(BaseSettings):
    PROJECT_NAME: str = "Timelink"
    VERSION: str = "1.0.0"
    API_V1_STR: str = "/api/v1"
    
    # CORS
    BACKEND_CORS_ORIGINS: List[AnyHttpUrl] = [
        "http://localhost:3000",  # React 개발 서버
        "https://timelink.digital",  # 프론트엔드 도메인
    ]
    
    # Database (Cloudflare D1 사용시 SQLite 호환)
    DATABASE_URL: str = "sqlite+aiosqlite:///./timelink.db"
    
    # JWT
    SECRET_KEY: str = "your-secret-key-here-change-in-production"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    
    # Suno AI 설정
    SUNO_API_BASE_URL: str = "https://api.suno.ai/v1"
    SUNO_API_KEY: Optional[str] = None
    
    # TL 토큰 설정
    TL3_INITIAL_BALANCE: int = 1000
    TL_RELEASE_RATE: int = 10  # 10초마다 해제되는 TL
    CAR_MODE_MULTIPLIER: float = 2.0
    
    class Config:
        env_file = ".env"
        case_sensitive = True

settings = Settings()
