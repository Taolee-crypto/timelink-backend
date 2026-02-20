# timelink-backend
# TimeLink Backend

TimeLink 플랫폼의 FastAPI 기반 백엔드

## 기술 스택
- FastAPI
- PostgreSQL + SQLAlchemy
- Redis (Streams, Pub/Sub, Rate Limiting)
- JWT + Refresh Token + Email Verification
- WebSocket 실시간 알림
- Celery + Redis (배치 작업, DLQ 처리)

## 실행 방법
```bash
pip install -r requirements.txt
uvicorn app.main:app --reload
