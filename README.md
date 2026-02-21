# TimeLink Backend

AI 시대 시간 기반 미디어 경제 플랫폼의 FastAPI 백엔드

## 핵심 기능
- 시간 단위 콘텐츠 보상 (TL3/TL4 포맷)
- 실시간 재생 정산 (WebSocket)
- 기여도 기반 TLC 채굴 (마이너스 기여도 포함)
- 금 담보 가치 안정화
- DLQ(Dead Letter Queue) 모니터링 + Slack 알림
- Redis Streams를 이용한 고성능 broadcast

## 기술 스택
- Backend: FastAPI (Python 3.11+)
- Database: PostgreSQL + SQLAlchemy
- Cache/Real-time: Redis (Pub/Sub, Streams, Rate Limiting)
- Auth: JWT + Refresh Token + Email Verification
- Task Queue: Celery
- Monitoring: Prometheus + Alertmanager → Slack
- Test: pytest + pytest-asyncio

## 빠른 시작

```bash
git clone https://github.com/Taolee-crypto/timelink-backend.git
cd timelink-backend
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
