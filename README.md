<<<<<<< HEAD
# timelink-backend
=======
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

## 현재 MVP 작동 상태 (2026.02.21 기준)

- `/health` 엔드포인트 정상
- `/tl/balance` 엔드포인트 정상 (DB에서 실제 잔고 읽기)
- 프론트 index.html 버튼 클릭 → 실시간 잔고 표시 성공
- SQLite DB 연결 완료 (timelink.db 파일 생성됨)

테스트 방법:
1. 백엔드 실행: `uvicorn app.main:app --reload`
2. 브라우저에서 index.html 열기 → "TL 잔고 확인하기" 버튼 클릭
## MVP 작동 데모 (2026.02.21 기준)

<image-card alt="잔고 확인 & 충전 데모" src="https://user-images.githubusercontent.com/너의아이디/캡처이미지링크.png" ></image-card>

- TL 잔고 확인 버튼 → 실시간 조회 성공
- 충전 입력 후 버튼 클릭 → 잔고 증가 & 자동 갱신
- 백엔드 API 연결 + SQLite DB 실제 저장 확인

# Timelink Backend API

FastAPI 기반 Timelink 플랫폼 백엔드 API (Suno AI 연동)

## 주요 기능

- 🔐 JWT 인증 (로그인/회원가입)
- 🎵 타임라인 포스트 CRUD
- 🤖 Suno AI 음원 변환 (TL3 토큰)
- 💰 TL 토큰 시스템 (충전/전송/락)
- 🚗 Car Mode (2배 보상)
- 📊 신뢰 점수 시스템 (Trust/LVS)

## 기술 스택

- FastAPI
- SQLAlchemy (Async)
- SQLite (개발) / PostgreSQL (프로덕션)
- Alembic (마이그레이션)
- JWT 인증
- Docker

## 설치 및 실행

### 로컬 개발

```bash
# 가상환경 생성
python -m venv venv
source venv/bin/activate  # Mac/Linux
# venv\Scripts\activate  # Windows

# 패키지 설치
pip install -r requirements.txt

# 데이터베이스 마이그레이션
alembic upgrade head

# 서버 실행
uvicorn app.main:app --reload
>>>>>>> a31cb8f9bf578d1b044a2df2f851fa6e7bbe4e3d
