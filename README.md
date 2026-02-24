# TimeLink Backend v2.0

AI 시대 시간 기반 미디어 경제 플랫폼의 백엔드

## 기술 스택

- **FastAPI** + Python 3.11
- **SQLite** (개발) / **PostgreSQL** (프로덕션)
- **SQLAlchemy 2.0** Async ORM
- **Alembic** DB 마이그레이션
- **JWT** 인증

## 빠른 시작

```powershell
python -m venv venv
.\venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

API 문서: http://localhost:8000/api/docs

## 주요 엔드포인트

| Method | Path | 설명 |
|--------|------|------|
| POST | `/api/v1/auth/register` | 회원가입 + 1000 TL 보너스 |
| POST | `/api/v1/auth/login` | 로그인 |
| GET | `/api/v1/users/me/wallet` | 지갑 상태 |
| POST | `/api/v1/files/upload` | 파일 업로드 |
| POST | `/api/v1/files/{id}/auth-request` | 인증 신청 |
| PATCH | `/api/v1/files/{id}/share` | 공유 설정 |
| POST | `/api/v1/playback/{id}/play` | 재생 처리 |
| GET | `/api/v1/shareplace` | SharePlace 목록 |
| POST | `/api/v1/disputes` | 이의제기 접수 |
| GET | `/api/v1/charts/hot` | 실시간 차트 |
| GET | `/api/v1/shareplace/contributor-ranking` | 기여자 랭킹 |

## TL 흐름

회원가입 → 1000 TL → 파일 업로드/충전 → 인증 → SharePlace → 재생 → 수익 분배 70%

## 테스트

```powershell
pytest tests/ -v
```
