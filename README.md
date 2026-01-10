server/
├─ app.js                        # Express / Worker Router 진입점
├─ server.js                     # Workers용 진입점
├─ server-dev.js                 # 로컬 개발용
├─ routes/                       # 역할별 API 라우트
│   ├─ auth.js                   # 회원가입, 로그인, JWT
│   ├─ wallet.js                 # TL 잔액 조회, TL 충전/소모
│   ├─ ledger.js                 # Ledger 조회, 이벤트
│   ├─ cafe.js                   # 카페 구독 관리, TL 소모
│   ├─ user.js                   # 사용자 대시보드용 API
│   ├─ ai-music.js               # AI 음악 생성, 예약 TL 관리
│   └─ platform.js               # 운영자/관리자 API
│
├─ workers/                       # Cloudflare Workers 전용
│   ├─ api.js                     # Worker API 진입점
│   ├─ auth.js                    # JWT 인증 처리
│   ├─ wallet.js                  # TL3 / 구독 TL 처리
│   ├─ ledger.js                  # Ledger 기록/조회
│   ├─ constants.js               # 공통 상수
│   ├─ files.js                   # TL3 파일 관리
│   ├─ subscription.js            # 카페 구독 로직
│   └─ worker.js                  # Worker main
│
├─ lib/                           # 공통 라이브러리
│   ├─ crypto.js                  # 서명 / 암호화
│   ├─ send-email.js               # 이메일 인증
│   └─ helpers.js                  # 유틸
│
├─ migrations/                     # DB / KV 스키마
│   ├─ 0001_init_users.sql
│   ├─ 001_initial.sql
│   └─ 003_p2p_marketplace.sql
│
├─ scripts/
│   ├─ deploy-workers.sh
│   ├─ setup-config.sh
│   ├─ create_sample_tld.py
│   └─ generate_keys.py
│
├─ timelink-mvp/
│   ├─ converter/                 # TL3 생성기 / 변환기
│   │   ├─ __init__.py
│   │   ├─ main.py
│   │   └─ run_converter.py
│   ├─ viewer/                    # TL3 뷰어
│   │   ├─ __init__.py
│   │   ├─ gui_viewer.py
│   │   └─ run_viewer.py
│   ├─ keys/
│   │   ├─ private_test.key
│   │   └─ public_test.pub
│   └─ setup.py
│
└─ workers/
    ├─ src/
    │   ├─ index.js
    │   ├─ package.json
    │   ├─ package-lock.json
    │   └─ wrangler.toml
    └─ test-worker.js
