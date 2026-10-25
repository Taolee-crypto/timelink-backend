# TimeLink V5 Music Gate 운영 검증 — 2026-10-25

실제 사용자 제출 테스트 MP3에 대해 운영 D1의 해당 심사 기록을 한정 조회하여 검증했다. 원본 음성, API 키, 원본 저장 경로와 음성 전사문은 진단 로그에 출력하지 않았다.

## 수정한 원인

- D1 meta.changes는 감사 트리거 쓰기까지 포함한다. 정확히 1건이라는 검사 때문에 상태 저장 성공을 충돌로 오인하고 분석을 시작하지 못했다. Music Gate 선점·진행·완료·재시도와 관리자 결정은 조건부 UPDATE RETURNING id로 확인하도록 수정했다.
- Cloudflare Workers는 redirect:error를 지원하지 않는다. AI 요청이 전송되기 전에 TypeError가 발생했다. manual로 변경하고 3xx 응답은 명시적으로 거부하여 키가 다른 주소로 전달되지 않게 했다.
- 신규 Gemini 프로젝트의 기존 2.5 모델 접근 제한으로 실제 API가 404를 반환했다. 무료 등급과 오디오 입력을 지원하는 gemini-3.5-flash-lite로 운영 모델 Secret을 수정했다. 결제 설정은 변경하지 않았다.
- AI가 위험 신호를 반환하면서 전체 안전성 표시를 clear로 보낸 경우 결과 전체를 버리던 검증을 수정했다. 구체적인 위험 신호를 보존하고 보수적으로 검토 대상으로 정규화하며, 제공자의 원래 안전성 표시는 따로 보존한다.

## 실제 운영 결과

분석 단계 finished, analysis_complete=1, analysis_error=null을 확인했다. 실제 모델이 보고한 위험 신호는 profanity와 targeted_harassment였다. 최종 상태는 review_required다. 이는 위험 신호 추출 성공을 뜻하며 위반 확정 판정은 아니다. 자동 승인, TL3 변환, 보상 지급, PoC 감점과 스트라이크를 실행하지 않았다.

## 검증과 운영 안전

SQLite 어댑터를 D1의 total_changes 차이값으로 수정하여 감사 트리거가 있는 실제 조건을 재현했다. Cloudflare workerd/Miniflare에서 미지원 redirect 오류와 수정 후 모의 AI 응답 수신, 리다이렉트 차단을 검증했다. 해당 검사는 배포 전 필수 단계에 포함했다. 통합·회귀 검사와 운영 배포가 통과했다.

분석 체크포인트 이전의 변경 건수 오판 작업과 전송 전 실패 작업만 한 번 복구하도록 제한했다. 완료된 분석·관리자 근거·승인·반려는 복구 대상에서 제외한다. 재시도는 본인 기록만 가능하고 이미 접수된 요청은 같은 처리 상태를 반환한다. 이 사건 확인용 임시 진단·모델 설정·대기열 복구 workflow는 확인 후 제거했다.

참고: https://developers.cloudflare.com/api/resources/d1/ , https://developers.cloudflare.com/workers/runtime-apis/request/ , https://ai.google.dev/gemini-api/docs/deprecations , https://ai.google.dev/gemini-api/docs/pricing
