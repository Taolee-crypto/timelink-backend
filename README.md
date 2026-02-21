# TimeLink Backend

AI 시대 시간 기반 미디어 경제 플랫폼의 FastAPI 백엔드

## 프로젝트 소개
TimeLink는 **시간 기반 보상 경제**를 실현하는 플랫폼입니다.  
- 콘텐츠 재생 1초마다 실시간 정산  
- 기여도(Contribution) 기반 TLC 채굴  
- 금 담보 가치 안정화  
- WebSocket 실시간 알림 & DLQ 모니터링 + Slack Alert  

프론트엔드 저장소: https://github.com/Taolee-crypto/timelink

## 기술 스택
- Backend: FastAPI (Python 3.11+)
- Database: PostgreSQL + SQLAlchemy
- Cache & Real-time: Redis (Pub/Sub, Streams, Rate Limiting)
- Auth: JWT + Refresh Token + Email Verification
- Task Queue & DLQ: Celery + Redis Streams
- Monitoring: Prometheus + Grafana + Alertmanager → Slack
- Test: pytest + pytest-asyncio + coverage

## 빠른 시작 (Local)

```bash
# 1. 클론 & 환경 설정
git clone https://github.com/Taolee-crypto/timelink-backend.git
cd timelink-backend
python -m venv venv
.\venv\Scripts\activate

# 2. 의존성 설치
pip install -r requirements.txt

# 3. .env 파일 생성 (필수 변수 채우기)
copy .env.example .env

# 4. 서버 실행
uvicorn app.main:app --reload --port 8000
