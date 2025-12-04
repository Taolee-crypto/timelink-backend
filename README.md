timelink-backend/
├── 📁 src/
│   ├── 📁 api/                      # API 엔드포인트
│   │   ├── auth/                    # 인증 관련
│   │   │   ├── login.js
│   │   │   ├── register.js
│   │   │   ├── logout.js
│   │   │   ├── refresh.js
│   │   │   └── social-auth.js      # 소셜 로그인
│   │   │
│   │   ├── user/                    # 사용자 관련
│   │   │   ├── profile.js
│   │   │   ├── library.js
│   │   │   ├── stats.js
│   │   │   ├── balance.js
│   │   │   └── settings.js
│   │   │
│   │   ├── content/                 # 콘텐츠 관련
│   │   │   ├── upload.js
│   │   │   ├── convert.js
│   │   │   ├── list.js
│   │   │   ├── play.js
│   │   │   ├── delete.js
│   │   │   └── metadata.js
│   │   │
│   │   ├── studio/                  # 스튜디오 관련
│   │   │   ├── projects.js
│   │   │   ├── save.js
│   │   │   ├── export.js
│   │   │   └── effects.js
│   │   │
│   │   ├── market/                  # 마켓 관련
│   │   │   ├── list.js
│   │   │   ├── sell.js
│   │   │   ├── buy.js
│   │   │   ├── search.js
│   │   │   └── recommendations.js
│   │   │
│   │   ├── tube/                    # TL 튜브 관련
│   │   │   ├── videos.js
│   │   │   ├── channels.js
│   │   │   ├── comments.js
│   │   │   └── subscriptions.js
│   │   │
│   │   ├── copyright/               # 저작권 관련
│   │   │   ├── request.js
│   │   │   ├── verify.js
│   │   │   ├── list.js
│   │   │   └── disputes.js
│   │   │
│   │   ├── payment/                 # 결제 관련
│   │   │   ├── deposit.js
│   │   │   ├── withdraw.js
│   │   │   ├── transactions.js
│   │   │   └── webhook.js
│   │   │
│   │   └── admin/                   # 관리자 기능
│   │       ├── users.js
│   │       ├── content.js
│   │       ├── reports.js
│   │       └── system.js
│   │
│   ├── 📁 middleware/               # 미들웨어
│   │   ├── auth.js                  # 인증 미들웨어
│   │   ├── validation.js            # 요청 검증
│   │   ├── rate-limit.js            # 요청 제한
│   │   ├── cors.js                  # CORS 설정
│   │   └── logger.js                # 로깅
│   │
│   ├── 📁 database/                 # 데이터베이스 관련
│   │   ├── models/                  # 데이터 모델
│   │   │   ├── User.js
│   │   │   ├── Content.js
│   │   │   ├── Transaction.js
│   │   │   ├── Copyright.js
│   │   │   └── MarketItem.js
│   │   │
│   │   ├── migrations/              # 데이터베이스 마이그레이션
│   │   ├── queries/                 # SQL 쿼리
│   │   └── schema.sql               # 데이터베이스 스키마
│   │
│   ├── 📁 services/                 # 비즈니스 로직
│   │   ├── auth.service.js          # 인증 서비스
│   │   ├── content.service.js       # 콘텐츠 서비스
│   │   ├── payment.service.js       # 결제 서비스
│   │   ├── conversion.service.js    # 변환 서비스
│   │   ├── copyright.service.js     # 저작권 서비스
│   │   ├── notification.service.js  # 알림 서비스
│   │   └── analytics.service.js     # 분석 서비스
│   │
│   ├── 📁 utils/                    # 유틸리티 함수
│   │   ├── encryption.js            # 암호화
│   │   ├── validation.js            # 검증
│   │   ├── file-utils.js            # 파일 처리
│   │   ├── audio-processor.js       # 오디오 처리
│   │   ├── video-processor.js       # 비디오 처리
│   │   ├── time-utils.js            # 시간 관련
│   │   └── error-handler.js         # 에러 처리
│   │
│   ├── 📁 storage/                  # 스토리지 관리
│   │   ├── cloudflare-r2.js         # R2 스토리지
│   │   ├── ipfs.js                  # IPFS 통합
│   │   └── cache.js                 # 캐시 관리
│   │
│   ├── index.js                     # 메인 진입점
│   └── router.js                    # 라우터 설정
│
├── 📁 tests/                        # 테스트 파일
│   ├── unit/                        # 단위 테스트
│   ├── integration/                 # 통합 테스트
│   └── e2e/                         # E2E 테스트
│
├── 📁 docs/                         # API 문서
│   ├── api-reference.md
│   ├── setup-guide.md
│   └── deployment.md
│
├── package.json                     # 프로젝트 설정
├── wrangler.toml                    # Cloudflare Workers 설정
├── .env.example                     # 환경변수 예시
├── .gitignore
├── README.md
└── LICENSE
