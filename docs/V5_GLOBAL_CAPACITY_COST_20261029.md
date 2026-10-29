# TimeLink V5 — 국가별 부하·비용 예측 검증 (개발 단계)
2026-10-29 · 기준 모델: `scripts/v5-global-capacity.cjs`

## 범위와 해석

한국·일본·미국(미 동부 시각으로 대표)·중국·태국·베트남의 가입자 분포와 현지 19–21시 집중 사용을 UTC 기준으로 합산한다. 10만/100만/1천만 MAU 모델에서 Workers 요청·CPU·D1 조회/쓰기·R2 요청/보관 비용을 추정하고, **관리자가 설정한 비용 예산과 엔지니어링 기준 RPS를 초과하면 경고**한다.

이 결과는 *시뮬레이션/회귀 검증*이다. 실제 국가별 CDN 체감 지연·실시간 음원 재생·부하 상황·Cloudflare 요금청구액을 측정한 것이 아니다. 프로덕션에 반복 요청을 보내지 않는다.

기본 가정은 DAU/MAU 18%, 활성 사용자 하루 Worker 요청 40회, 평균 Worker CPU 7ms/요청, D1 조회 12행·쓰기 1.1행/요청, R2 Standard Class B 요청 0.4회/Worker 요청, 월 30일, Workers Standard 플랜이다. 이 값은 **실측치가 아니라 수정 가능한 예시**다. RPS 한계 300 역시 실측 Worker 능력이 아니라 추후 성능시험의 목표값이다. 실제 수익·마케팅·인건비·권리 비용·PG 비용·AI 분석·TON 체인 비용을 포함하지 않는다.

## 실행

```bash
node scripts/test-v5-global-capacity.cjs
node scripts/v5-global-capacity.cjs --mau=1000000 --budget=100 --rps-limit=300
node scripts/v5-global-capacity.cjs --mau=10000000 --budget=1500 --rps-limit=500 --fail-on-alert=true
```

결과 JSON의 `countryShares`는 국가별 모델 MAU·월 API 요청·현지 피크 RPS·변동 비용 배분, `worldwidePeakUTC`와 `worldwidePeakRps`는 시간대 중첩을 반영한 글로벌 피크 추정, `alerts`는 운영 게이트 경고를 뜻한다. `estimatedCosts`에는 비용 항목별 예측이 있다.

## 요금 기준 출처

- Workers Standard: https://developers.cloudflare.com/workers/platform/pricing/
- D1: https://developers.cloudflare.com/d1/platform/pricing/
- R2 Standard: https://developers.cloudflare.com/r2/pricing/

2026-10-29 확인된 공개 단가를 예측 코드에 기재했다. 실제 Cloudflare 플랜/계약·할당량·캐시 정책·계산서가 우선한다.

## 출시 전 필수 추가 검증

국가별 시간대의 실제 사용자 세션·재생당 R2 요청·API 지연 분포(P50/P95/P99)·Worker CPU·D1 스캔 행·스토리지 사용량을 **Cloudflare 실측**으로 교체해야 한다. 비공개 스테이징에서 부하를 점진적으로 올려 재생 끊김, 결제·원장 중복, D1 잠금/성능, 장애 복구를 확인하고 운영자 승인 이후에만 프로덕션 트래픽을 확장한다.

규칙: 실측 근거 없는 100% *운영확인* 금지, 프로덕션에 무단 고부하 테스트 금지.
