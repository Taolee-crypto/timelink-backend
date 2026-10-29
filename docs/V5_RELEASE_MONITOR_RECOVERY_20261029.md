# TimeLink V5 운영 감시 · 백업 복구 안전 절차

2026-10-29 기준, 개발관리대장 TLV5-064 근거. **프로덕션 복원은 수행하지 않습니다.**

## 실제로 검증한 범위

- Worker 공개 `/api/v1/health` 응답과 DB 간단 연결 조회
- Cloudflare D1 `timelink-db`의 **정확한 DB ID** 확인
- D1 Time Travel **현재 시점 북마크 조회 가능 여부** (복구 토큰 원문 출력/저장 금지)
- Worker 및 두 Pages 운영 배포 존재·성공 확인
- GitHub Actions **6시간마다 read-only 점검**, 실패 시 CI에 실패 표기
- 분리된 **가짜 SQLite** 데이터로 백업 사본 생성→손상 시나리오→백업에서 재열기→원장·대장·integrity_check 대조

D1 실서비스 DB의 **실제 시점 복구 연습은 아직 하지 않았으며 자동 실행하지 않습니다**. Cloudflare Time Travel이 지원되더라도 이 사실만으로 실제 D1 복구 성공을 주장하지 않습니다.

## 운영 감시

`node scripts/v5-release-watch.cjs` 로 수동 조회할 수 있으며 GitHub `V5 operational watch and recovery readiness` workflow가 정기 실행합니다. 필요한 CI secrets는 `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` 입니다. API 토큰은 가능하면 D1/Workers/Pages 조회 권한만 사용해야 합니다.

모든 검사 **GET만 호출**하며 결제·원장·권리·암호화 키·DB 상태는 변경하지 않습니다. 실패한 상태 코드/항목만 CI에서 표시하고 HTTP 원문이나 북마크 값은 출력하지 않습니다.

## D1 시점 복구 사고 대응 (자동화 금지)

1. 배포·경제원장 지급·결제 신규 요청을 안전하게 통제하고 사고 시각을 기록합니다.
2. 운영자 승인과 법적·정산 책임자 확인을 받고, **현재 DB의 무손실 보전(백업/별도 저장)** 여부를 확인합니다.
3. Cloudflare 공식 D1 Time Travel 문서에서 현재 요금제의 복구 가능 범위·북마크·타임스탬프를 확인합니다.
4. 가능한 경우 **격리된 검사 DB에 먼저 복원 가능성을 검증**하고 회원·창작자 권리·거래·결제 외부 PG 상태를 대조합니다.
5. 승인된 복구 시점을 정하고 결제 이벤트 재생·멱등키 재확인·지급 중복 방지 계획을 수립합니다.
6. 운영자가 사고 대응 절차에 따라 최종 복원 여부를 결정하고, 복원 후 회계 원장과 PG 영수증을 대조합니다.

절대로 단순한 감시 실패나 CI 스크립트만으로 운영 D1에 `restore`, `delete`, `reset` 요청을 하지 않습니다. `TL3_MASTER_KEYRING`, `TL3_MASTER_SECRET`, 결제 키는 DB 백업과 별도로 안전하게 보존합니다.

관련 Cloudflare 문서: https://developers.cloudflare.com/d1/reference/time-travel/ 및 Cloudflare D1 API의 `time_travel/bookmark`, `time_travel/restore` 명세.
