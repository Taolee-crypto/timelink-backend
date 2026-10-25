# TimeLink V5 AI Music Gate 실제 분석 Worker

기준: backend main `14767d724e9518c5807746a39d65e8039c6aface`, frontend main `4317bb0f6bbdd6daf4d0caecb01615e90aa18590`.

## 구현

기존 분 단위 Worker cron에 분석 작업을 연결한다. MP3 업로드는 기존 D1 저장소와 심사 대기열을 그대로 사용한다. 매 실행에서 준비된 작업 한 건을 조건부 UPDATE로 선점하고 180초 임대를 둔다. 소유자별 저장 경로와 실제 원본 SHA-256이 심사 기록과 일치해야 외부 모델에 전달한다. 본문은 원본 MP3 전체이며 10 MiB까지 지원한다. 초과 파일은 자동 승인하거나 부분 분석하지 않고 예외 심사로 보낸다. 기존 업로드 한도 100 MiB와 V5 제조 한도 16 MiB는 변경하지 않았다.

Gemini generateContent API에 MP3를 base64 inlineData로 보내 실제 오디오 이해를 요청한다. API 키는 헤더에만 넣고 모델은 운영 설정으로 지정한다. 음악·음성 점수, 전체 오디오 검토 여부, 위험 신호와 짧은 설명을 구조화한 JSON으로 받고 서버에서 다시 검증한다. 오디오 안의 지시는 신뢰하지 않도록 시스템 지침에 명시한다. 모델의 자체 보고와 점수는 검증된 디코딩 결과나 보정된 확률이 아니다.

타임아웃은 60초이며 응답은 64 KiB까지 읽는다. 429·5xx·네트워크 오류·잘못된 응답은 지수형 대기 후 총 3회까지 재시도한다. 분석 중 프로세스가 종료되면 임대 만료 후 재시도하거나 예외 심사로 보낸다. 임대 토큰, 원본 해시, 상태, 임대 만료 시각을 모두 확인하고 결과를 기록한다. 취소 또는 다른 심사 결정이 먼저 끝났으면 결과를 덮어쓰지 않는다.

분석 근거와 그 SHA-256을 보존한다. DB 트리거는 기존 기록의 초기 상태, 분석 시도, 상태 전이, 근거 해시와 관리자 결정을 별도 감사 테이블에 기록한다. 감사 기록은 UPDATE/DELETE를 금지한다. 관리자 수동 분석 입력에도 근거 해시를 계산한다. Creator 상태 조회의 Bearer 정규식 오류도 수정했다.

## 유지한 정책과 제한

AI 위험 신호는 PoC 감점·스트라이크 확정 근거가 아니다. 확정 제재는 기존 별도 심사 절차를 따른다. 이 Worker는 지갑, V5 경제원장, 70:30 보상, TILO 재원, TL/TLC 교환을 수정하거나 호출하지 않는다.

실제 AI 분석은 구현했지만 독립 MP3 디코더, 음원 지문 검색, 외부 카탈로그 검증은 아직 연결하지 않았다. 따라서 decoded 및 fingerprint_matches를 null, catalog_match를 unavailable로 기록하고 수동 예외 심사로 보낸다. 정상 음원 자동 승인은 아직 활성화하지 않는다. 자동 전환 전에 독립 검증과 이의신청·승인 취소 절차를 완성해야 한다. 분석 승인, 저작권 입증, 공개 허가, 보상 허가는 별도다. 기본 분석 실행도 비활성이다. API 키 없이 정상 분석을 했다고 기록하지 않는다.

## 운영 설정과 배포

Cloudflare Worker Secret에 `MUSIC_GATE_GEMINI_API_KEY`를 설정한다. 실제 사용 가능한 오디오 입력 모델 ID를 `MUSIC_GATE_GEMINI_MODEL`, 실행 스위치를 `MUSIC_GATE_ANALYSIS_ENABLED=true`로 설정한다. 이 두 값도 Worker Secret으로 저장하면 Wrangler 재배포 시 일반 vars 덮어쓰기의 영향을 받지 않는다. 값이 없으면 cron은 외부 API를 호출하지 않고 대기열도 선점하지 않는다. 서비스 API를 쓸 경우 기존 `MUSIC_GATE_WORKER_SECRET`을 32자 이상으로 설정한다. 키를 저장소나 프런트엔드에 기록하지 않는다.

배포 workflow는 TypeScript와 분석 통합 테스트를 실행한 뒤 Music Gate 기본 마이그레이션과 Worker 확장 마이그레이션을 적용·확인하고 Worker를 배포한다. `scripts/prepare-music-gate-schema.cjs`는 확장 컬럼이 없을 때만 ALTER 마이그레이션을 적용한다. 모두 존재하면 확인만 하고, 일부만 있으면 중단한다. 기존의 전체 마이그레이션을 무차별 재실행하지 않는다. 운영 데이터는 삭제하지 않는다.

운영 상태 확인: `GET /api/v1/music-gate/health`. `pipeline_version`과 `schema_ready`는 배포 확인이고, `ready`는 실행 설정 준비 여부다. 실제 추론 성공은 아니다. 준비되지 않으면 HTTP 503을 반환한다. `automatic_approval_enabled`는 false다. 원본 경로·근거·키는 공개하지 않는다.

서비스 인증 후 `POST /api/admin/v5/music-gate/automation/run`으로 한 작업을 동기 실행할 수 있다. 인증 헤더는 `X-Music-Gate-Worker-Secret`이다. `GET /automation/health`와 기존 `GET /automation/pending`도 같은 인증을 사용한다. 관리자 JWT로 `GET /api/admin/v5/music-gate/reviews/:id`를 호출하면 분석 근거와 최근 감사 기록 100건을 확인한다. 일반 사용자는 본인 Creator 상태 조회 API만 사용할 수 있다.

## 검증 구분

`node scripts/test-v5-music-gate-worker.cjs`는 실제 SQLite와 애플리케이션 라우터를 사용한다. AI 서버 응답만 모의하며 원본 바이트 전송, 해시 불일치 차단, 동시 선점, 재시도, 취소 충돌, 임대 만료, 위험 신호, 잘못된 응답, 감사 기록 불변성, 관리자/서비스/소유자 권한을 검증한다. 라이브 AI 정확도나 실제 음원 판별 품질을 검증한 것으로 보고하면 안 된다.

실제 운영 검증에는 모델 키 설정 후 권리가 확보된 테스트 MP3를 업로드하고, 원본 해시·provider response ID·분석 근거·감사 전이와 Creator 상태를 대조해야 한다. 운영 키와 배포 승인이 없으면 해당 검증은 미완료로 남긴다.

API 참고: https://ai.google.dev/gemini-api/docs/generate-content/audio
