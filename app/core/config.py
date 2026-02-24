from pydantic_settings import BaseSettings
from pydantic import field_validator
from typing import List
import json


class Settings(BaseSettings):
    APP_VERSION: str = "2.0.0"
    ENVIRONMENT: str = "development"
    DEBUG: bool = True

    DATABASE_URL: str = "sqlite+aiosqlite:///./timelink.db"

    @field_validator("DATABASE_URL", mode="before")
    @classmethod
    def fix_db_url(cls, v):
        # postgres:// → postgresql+asyncpg:// (Heroku 등 구버전 URL 호환)
        if isinstance(v, str) and v.startswith("postgres://"):
            v = v.replace("postgres://", "postgresql+asyncpg://", 1)
        return v

    SECRET_KEY: str = "changethis"
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    REFRESH_TOKEN_EXPIRE_DAYS: int = 30

    BACKEND_CORS_ORIGINS: List[str] = ["http://localhost:3000", "http://127.0.0.1:5500"]

    @field_validator("BACKEND_CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors(cls, v):
        if isinstance(v, str):
            return json.loads(v)
        return v

    UPLOAD_DIR: str = "./uploads"
    MAX_FILE_SIZE_MB: int = 500

    TL_INITIAL_BONUS: int = 1000
    CAR_MODE_MULTIPLIER: float = 2.0
    REVENUE_SHARE_RATE: float = 0.7
    EXCHANGE_RATE: float = 0.5

    ANTHROPIC_API_KEY: str = ""

    model_config = {"env_file": ".env", "case_sensitive": True, "extra": "ignore"}


settings = Settings()
