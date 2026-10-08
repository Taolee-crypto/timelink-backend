# TimeLink Backend — Cloudflare Workers + D1

> **"파일을 파는 것이 아니라, 사용할 권리를 판매합니다."**
> — TimeLink, 특허 출원 10-2025-0167813

---

## 📜 TL 파일 제조 원칙

TimeLink의 핵심 철학과 아키텍처 원칙은 별도 문서로 관리합니다.

**→ [TL_PRINCIPLES.md](./TL_PRINCIPLES.md) 참조**

### 6대 원칙 요약

| # | 원칙 | 핵심 |
|---|------|------|
| 1 | **TL이 있는 만큼만 사용** | 파일은 잠재 상태. TL 소진 = 무력화 |
| 2 | **스파인 기능** | 순방향만 매끄러움. 역방향/우회는 손상 |
| 3 | **LP/확장 별도 모듈** | TL 파일은 순수 원본. 확장은 별도 JS |
| 4 | **창작자 PC 저장** | 서버는 중계자. 창작자가 원본 소유 |
| 5 | **TLNK 컨테이너** | 음원/영상/문서 공통 포맷 |
| 6 | **저작권자 정보 삽입** | 암호학적 귀속 (헤더+AAD+스파인+워터마크) |

---

## 🚀 배포 방법

### 1. 의존성 설치
```bash
npm install
```

### 2. D1 데이터베이스 생성
```bash
npx wrangler d1 create timelink-db
```
출력된 `database_id`를 `wrangler.toml`의 `database_id`에 붙여넣기

### 3. 마이그레이션 실행
```bash
npx wrangler d1 migrations apply timelink-db
```

### 4. JWT Secret 설정
```bash
npx wrangler secret put JWT_SECRET
# 입력: 긴 랜덤 문자열 (예: openssl rand -hex 32)
```

### 5. TL3 Master Secret 설정 (TL3 사용 시)
```bash
npx wrangler secret put TL3_MASTER_SECRET
# 입력: 32바이트 이상 랜덤
```

### 6. 로컬 에이전트 URL 설정 (환경 변수)
`wrangler.toml`의 `[vars]`:
```toml
[vars]
LOCAL_AGENT_BASE = "https://agent.timelink.digital"
```

### 7. 배포
```bash
npx wrangler deploy
```

배포 완료 후 URL: `https://timelink-backend.<your-subdomain>.workers.dev`

### 8. 프론트엔드 API_BASE 업데이트
`public/index.html`에서:
```js
var API_BASE = 'https://timelink-backend.<your-subdomain>.workers.dev';
```

---

## 💻 로컬 개발

```bash
npm run dev
```

---

## 🗂️ 저장소 구조

```
timelink-backend/
├── src/
│   ├── index.ts           메인 Worker (Hono)
│   ├── tl3v3.ts           TL3 v3 빌더 (AES-256-GCM, 스파인)
│   ├── tl3_crypto.ts      암호 유틸 (HKDF, HMAC, AES-GCM)
│   ├── tl_format.ts       TLNK 컨테이너 유틸
│   ├── routes/
│   │   ├── tl3.ts         TL3 API (create, segment, confirm)
│   │   ├── auth.ts        인증
│   │   ├── users.ts       사용자
│   │   ├── cafe.ts        카페
│   │   ├── dj-cafe.ts     DJ 카페
│   │   └── ...
│   ├── storage.ts         D1 스토리지
│   ├── ledger.ts          회계 (TL 소비)
│   ├── economics.ts       경제 시스템
│   └── types.ts           공통 타입
├── migrations/
│   ├── 0001_initial.sql
│   ├── tl3_v3.sql         tl3_releases, tl3_segments, tl3_tokens
│   └── tl3_v3_alter.sql
├── wrangler.toml
├── TL_PRINCIPLES.md       TL 파일 원칙 (핵심)
└── README.md              ← 이 문서
```

---

## 🔗 관련 저장소 / 파일

### 프론트엔드 (`timelink-frontend`)
- `public/tl3.js` — TL3 클라이언트
- `public/tl3-config.js` — API base
- `public/shareplace.html`, `creator.html`, `track.html` — 사용 페이지
- `local-agent/server.js` — 창작자 PC 로컬 에이전트 (PM2: `timelink-agent`, port 8787)

### 인프라
- **Cloudflare Worker**: `timelink-backend`
- **Cloudflare Pages**: `timelink-frontend`
- **Cloudflare Tunnel**: `agent.timelink.digital` → 로컬 에이전트
- **D1**: `timelink-db` (remote)
- **도메인**: `www.timelink.digital`, `api.timelink.digital`

---

## 🧪 검증 명령

### 서버 상태 확인
```powershell
curl.exe -s -o NUL -w "HTTP %{http_code}`n" "https://api.timelink.digital/api/shares"
```

### 로컬 에이전트 상태
```powershell
curl.exe -s "http://127.0.0.1:8787/health"
```

### D1 테이블 조회
```powershell
npx wrangler d1 execute timelink-db --remote --json --command="SELECT name FROM sqlite_master WHERE type='table'"
```

---

## 📄 특허

**출원번호 10-2025-0167813**
> "시간 충전형 디지털 파일 기반 창작자 수익 창출, AI 예측 및 대출 연계 통합 시스템"

---

## 📜 라이선스

(예정)

---

*Last updated: 2026-10-08*