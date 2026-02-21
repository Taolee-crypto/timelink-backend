# TimeLink Backend (FastAPI)

AI 시대 시간 기반 미디어 경제 플랫폼의 백엔드

## 프로젝트 소개
TimeLink는 **시간 단위 콘텐츠 보상**을 실현하는 플랫폼입니다.  
- 콘텐츠 재생 1초마다 실시간 정산  
- 기여도 기반 TLC 채굴 (마이너스 기여도 지원)  
- 금 담보 가치 안정화  
- WebSocket 실시간 알림 & DLQ 모니터링 + Slack Alert  

프론트엔드 저장소: https://github.com/Taolee-crypto/timelink

## 기술 스택
- Backend: FastAPI (Python 3.11+)
- Database: PostgreSQL + SQLAlchemy
- Cache & Real-time: Redis (Pub/Sub, Streams, Rate Limiting)
- Auth: JWT + Refresh Token + Email Verification
- Task Queue & DLQ: Celery + Redis Streams
- Monitoring: Prometheus + Alertmanager → Slack
- Test: pytest + pytest-asyncio + coverage

## CI 상태
[![Tests](https://github.com/Taolee-crypto/timelink-backend/actions/workflows/test.yml/badge.svg)](https://github.com/Taolee-crypto/timelink-backend/actions/workflows/test.yml)
[![Coverage](https://codecov.io/gh/Taolee-crypto/timelink-backend/branch/main/graph/badge.svg)](https://codecov.io/gh/Taolee-crypto/timelink-backend)

## 빠른 시작 (Local)

```bash
git clone https://github.com/Taolee-crypto/timelink-backend.git
cd timelink-backend
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

주요 엔드포인트 예시

/auth/register – 회원가입 + 이메일 인증
/tl/purchase – TL 충전
/mining/start – TLC 채굴 시도
/ws/mining/{user_id} – 실시간 채굴 알림 (WebSocket)

라이선스
MIT License
연락처 /mununglee@gmail.com

X: @Taolee_crypto
Issue/PR 환영합니다!
