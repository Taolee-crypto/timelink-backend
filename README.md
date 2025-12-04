timelink-backend/ (백엔드)
├── src/
│   ├── index.js                 # Worker 메인 엔트리
│   ├── api/                     # API 엔드포인트
│   │   ├── auth.js
│   │   ├── files.js
│   │   ├── market.js
│   │   ├── studio.js
│   │   ├── copyright.js
│   │   └── payments.js
│   ├── middleware/              # 미들웨어
│   │   ├── auth.js
│   │   └── validation.js
│   ├── models/                  # 데이터 모델
│   │   ├── User.js
│   │   ├── File.js
│   │   └── MarketItem.js
│   └── utils/                   # 유틸리티
│       ├── database.js
│       └── encryption.js
├── wrangler.json               # JSNOC 설정
├── package.json
├── schema.sql                  # D1 데이터베이스 스키마
└── .env.example
