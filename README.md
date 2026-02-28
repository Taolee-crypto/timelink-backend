# TimeLink Backend v2 — Cloudflare Workers + D1

## 배포 방법

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

### 5. 배포
```bash
npx wrangler deploy
```

배포 완료 후 URL: `https://timelink-backend.<your-subdomain>.workers.dev`

### 6. 프론트엔드 API_BASE 업데이트
`public/index.html`에서:
```js
var API_BASE = 'https://timelink-backend.<your-subdomain>.workers.dev';
```

## 로컬 개발
```bash
npm run dev
```
