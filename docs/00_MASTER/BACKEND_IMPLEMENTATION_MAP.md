# TimeLink Backend Implementation Map

- 상태: 코드 조사 초안 v0.1
- 조사 기준일: 2026-10-14
- 저장소: `Taolee-crypto/timelink-backend`
- 원칙: 코드 경로는 현재 저장소에서 확인된 위치를 뜻하며, 운영 배포 상태는 별도 검증 대상이다.

## 1. 런타임 구성

- Runtime: Cloudflare Workers
- Framework: Hono
- Database: Cloudflare D1 (`DB` binding)
- Main entry: `src/index.ts`
- Deployment config: `wrangler.toml`
- API host documented: `api.timelink.digital`

## 2. 모듈 지도

| 영역 | 파일 | 관찰된 책임 |
|---|---|---|
| 앱 조립·직접 API | `src/index.ts` | Hono 앱, API 라우트, TL3 경로, 업로드·스트림 호환 API |
| 인증 암호 유틸 | `src/auth.ts` | 비밀번호 해시/검증, JWT 발급/검증 |
| 인증 라우트 | `src/routes/auth.ts` | 가입, 로그인, 내 정보, 비밀번호 변경 |
| 사용자 | `src/routes/users.ts` | 사용자 조회·관리 |
| 파일 | `src/routes/files.ts` | 기존 `tl_files` 기반 업로드·공유·승인 |
| 재생 | `src/routes/playback.ts` | 구형 파일 재생·TL 차감·수익 기록, TL3 소비 경로 |
| SharePlace | `src/routes/shareplace.ts` | 공유 콘텐츠 등록·조회·기여 랭킹 |
| 경제 | `src/economics.ts` | 지갑·POC·TLC 관련 경제 API |
| 결제 | `src/payment.ts` | Toss/Stripe 결제 확인 및 TL 지급 흐름 |
| 광고 | `src/ads_backend.ts` | 광고 관련 API |
| 저장소 | `src/storage.ts` | Google Drive·OneDrive OAuth, 토큰 암호화, 업로드 세션, 외부 스트림 |
| D1 객체 | `src/d1-storage.ts` | D1 청크 파일 저장 및 Range 읽기 |
| TL3 암호화 | `src/tl3v3.ts` | v3 컨테이너 빌드·파싱·세그먼트 암복호화·토큰 체인 |
| TL3 키 유틸 | `src/tl3_crypto.ts` | Worker 마스터 시크릿을 HKDF 키로 가져오기 |
| 구형 TL 포맷 | `src/tl_format.ts` | v1 XOR 기반 TLNK 파일 생성·파싱·복호화 |

## 3. API 라우트의 주요 그룹

### 3.1 Hono 하위 라우터 마운트

- `/api/v1/auth`
- `/api/v1/users`
- `/api/v1/files`
- `/api/v1/playback`
- `/api/v1/shareplace`
- `/api/shares` (SharePlace 라우터 별칭)
- `/api/admin`
- `/api/cafe`
- `/api/search`
- `/api/dj`
- `/api/dj-cafe`
- `/api/cafe-subscriptions`
- `/api/settings`
- `/api/cafe-broadcast`
- `/api/contact`
- `/api/payment`
- `/api/eco`
- `/api/ads`
- `/api/v1/suno`

### 3.2 TL3 직접 API

- `POST /api/v1/tl3/releases`
- `GET /api/v1/tl3/resolve/:shareId`
- `GET /api/v1/tl3/header/:id`
- `GET /api/v1/tl3/segment/:id`
- `GET /api/v1/tl3/code/:id`
- `POST /api/v1/tl3/segment/confirm/:id`
- `POST /api/v1/tl3/offline/start`
- `GET /api/v1/tl3/offline/lic/:session_id`
- `POST /api/v1/tl3/offline/settle`

### 3.3 레거시 및 호환 업로드·스트림 API

- `POST /api/upload/mp3`
- `POST /api/upload/tl3`
- `POST /api/upload/init`
- `PUT /api/upload/part`
- `POST /api/upload/complete`
- `POST /api/upload`
- `POST /api/upload/tl`
- `GET /api/storage/:key`
- `GET /api/stream/:shareId`
- `POST /api/stream/:shareId/tick`
- `GET /api/download/:shareId`

위 API는 한 세대의 통일된 업로드 체계가 아니라 여러 구현 시점의 경로가 공존하는 것으로 보인다. 표준 경로를 지정하기 전까지 제거·통합하지 않는다.

## 4. 데이터베이스 현황

### 4.1 초기 마이그레이션에서 확인된 핵심 테이블
- `users`
- `tl_files`
- `transactions`
- `auth_requests`
- `play_events`
- `disputes`
- `poc_events`

### 4.2 별도 마이그레이션 및 코드에서 확인된 테이블
- `tl3_offline_sessions`
- `tl3_releases`
- `tl3_segments`
- `tl3_tokens`
- `tl3_stream_sessions`
- `tl3_play_sessions`
- `tl_shares`
- `tl_d1_objects`
- `tl_d1_object_parts`
- `storage_connections`
- `storage_oauth_states`
- `storage_objects`
- 결제·구독·Suno 관련 테이블

중요: 일부 테이블은 마이그레이션 파일이 아니라 요청 처리 중 `CREATE TABLE` 또는 `ALTER TABLE`로 생성된다. 운영 DB를 확인하기 전까지 이 목록은 완전한 최종 스키마가 아니다.

## 5. TLNK/TL3 구현 관찰

### v1
- `src/tl_format.ts`에 XOR 기반 키 생성과 파일 생성/파싱 코드가 있다.
- `src/index.ts`의 `/api/upload/tl` 경로는 고정 기본 시크릿 fallback을 포함한다.
- 보안 암호화 방식으로 인정할 수 없는 레거시 경로로 분류한다.

### v2
- `src/index.ts`의 `/api/upload` 경로는 TLNK magic 및 version byte 0x02를 검사하고 구형 헤더 오프셋을 사용한다.
- 현재 지원 범위와 파일 샘플을 확인해야 한다.

### v3
- `src/tl3v3.ts`는 AES-256-GCM, HKDF-SHA-256, SHA-256 기반 토큰 체인을 구현한다.
- `public/tl3.js`는 헤더·세그먼트·코드·확정 API를 사용한다.
- 온라인 재생과 오프라인 파일 재생 코드가 존재한다.
- 실제 세그먼트 시간 단위, 헤더에 포함되는 토큰 수, 서버와 클라이언트의 비밀 정보 경계는 별도 프로토콜 검토가 필요하다.

## 6. 재생·경제·TLC 처리 흐름

### TL3 재생 및 창작자 정산
- `src/routes/playback.ts`의 `/tl3/consume`은 재생 세션을 만들고 사용자 `tl_balance`에서 소비 초만큼 차감한다.
- 해당 경로는 소비액의 70%를 창작자 `tl_balance` 및 `total_tl_earned`에 적립하고 거래·재생 이벤트를 기록한다.
- 프런트엔드의 SharePlace 구형 경로는 `/api/shares/:id/consume`을 호출하므로, 이 직접 API와 `/api/v1/playback/tl3/consume` 라우터 경로가 동일한 원장·세션을 사용하는지 추가 확인이 필요하다.
- `src/economics.ts`는 `tl_p`, `tl_a`, `tl_b`, `tl`, `tl_balance` 등 여러 잔액 계열을 함께 사용한다. 단일 잔액이라고 단정하지 않는다.

### POC 및 TLC
- `src/economics.ts`에는 POC 재계산과 `/api/eco/mine-tlc` 채굴 경로가 구현되어 있다.
- 코드상 채굴량 계산은 월간 구매 TL 소비 기반값, POC 지수 및 플랜 배율을 사용하고, 결과를 `users.tlc_balance`와 `tlc_mining_v2`에 기록한다.
- SharePlace 등록 코드에는 MP3 업로드 POC 1점, TL3 업로드 POC 3점 분기가 남아 있다. 이는 무료 MP3 제외라는 최신 운영 방향과 충돌한다.
- `src/jetton.ts`의 `mintTLC`는 온체인 민팅을 직접 하지 않고 queued 식별자를 반환한다. 별도 `scripts/auto-mint.js`는 testnet TON SDK로 출금 대기건을 처리한다.
- 대표자 확인: 현재 TLC 채굴 시험 버전은 작동 중이다. 위 내용은 코드 경로를 분해해 기록한 것이며, 시험 결과를 부정하거나 미구현으로 분류하지 않는다.

## 7. 저장소 구현

### 사용자 소유 외부 저장소
- `src/storage.ts`에서 Google Drive 및 OneDrive OAuth를 구현한다.
- OAuth access/refresh token을 AES-GCM으로 암호화해 D1에 저장하는 구조다.
- 파일 업로드 세션 및 외부 Range 스트림 기능이 있다.

### D1 청크 저장
- `src/d1-storage.ts`는 1,500,000바이트 청크 단위로 D1 BLOB을 저장한다.
- 파일 최대 크기는 코드상 100 MiB로 설정되어 있다.
- 메타 테이블과 파트 테이블을 사용한다.

### Local Agent
- 프런트엔드 저장소의 `local-agent/server.js`가 창작자 PC의 파일 제공 기능을 담당한다.
- 백엔드는 Local Agent URL을 통해 파일을 중계하는 흐름을 문서화하고 있다.
- Local Agent의 실제 인증·토큰·Range·터널 동작을 별도 검토해야 한다.

## 8. 우선 정리할 기술 부채

1. 직접 라우트와 하위 라우터의 중복·별칭 정리.
2. 레거시 TLNK v1/v2 업로드 경로의 사용 여부 확인.
3. 동적 DDL을 정식 마이그레이션으로 옮길 범위 결정.
4. `tl_files`와 `tl_shares`의 관계 및 통합 여부 결정.
5. TL 잔액 컬럼(`tl_balance`, `tl`, `tl_p`, `tl_a`, `tl_b`)의 단일 원장 기준 확립.
6. 모든 업로드·다운로드 API의 인증과 소유권 검증 표준화.
7. Worker Secret과 공개 설정값의 분리.

## 9. 다음 검증

- API별 인증 필요 여부 및 실제 프런트엔드 호출 확인
- 각 API의 request/response 스키마 정리
- D1 운영 스키마와 마이그레이션 차이 확인
- TL3 온라인·오프라인 재생 세션 추적
- 경제·정산 원장 간 중복 지급/차감 가능성 검토
- Cloudflare 배포 설정 및 Secret 구성 점검
