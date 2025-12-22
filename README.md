# TimeLink 백엔드 API

회원가입, 로그인, 이메일 인증을 제공하는 백엔드 API

## 🚀 주요 기능
- 사용자 회원가입/로그인
- 6자리 이메일 인증번호 발송
- JWT 토큰 기반 인증
- Cloudflare Workers + D1 데이터베이스
- SendGrid 이메일 연동

## 📁 프로젝트 구조
\\\
.
├── worker.js              # 메인 API 코드
├── wrangler.toml.sample   # 배포 설정 샘플
├── .env.example          # 환경변수 샘플
├── .gitignore           # Git 무시 파일
└── README.md            # 이 파일
\\\

## 🔧 빠른 시작
1. \cp wrangler.toml.sample wrangler.toml\
2. \cp .env.example .env\
3. \
px wrangler deploy\

## 🔐 환경변수
- \SENDGRID_API_KEY\: SendGrid API 키
- \EMAIL_FROM\: 발신 이메일 주소
- \APP_URL\: 애플리케이션 URL
