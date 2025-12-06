#!/bin/bash
echo "🚀 TimeLink 백엔드 개발 서버 시작"
echo "================================"

# 설정 확인
echo "📋 현재 설정 확인:"
echo "Account ID: a056839cbee168dca5a9439167f98143"
echo "Database ID: cf631397-ed92-4d21-b989-f3b3cedb7ae4"
echo "Database Name: timelink-db"

# 데이터베이스 확인
echo -e "\n🗄️ 데이터베이스 상태 확인..."
npx wrangler d1 execute timelink-db --command="SELECT COUNT(*) as table_count FROM sqlite_master WHERE type='table';" 2>/dev/null || echo "데이터베이스 쿼리 실패"

# 로컬 개발 데이터베이스도 생성 (옵션)
if command -v sqlite3 &> /dev/null; then
    echo "💾 로컬 개발 데이터베이스 생성..."
    sqlite3 timelink-dev.db < schema.sql 2>/dev/null && echo "✅ 로컬 DB 생성 완료"
fi

# 패키지 확인
echo -e "\n📦 패키지 확인..."
npm list itty-router 2>/dev/null || npm install itty-router

# 서버 시작
echo -e "\n🌐 개발 서버 시작!"
echo "========================================="
echo "서버 주소: http://localhost:8787"
echo ""
echo "🛣️  주요 API 엔드포인트:"
echo "GET  /                    - 서버 상태"
echo "POST /api/auth/login      - 로그인"
echo "POST /api/auth/register   - 회원가입"
echo "GET  /api/user/profile    - 프로필 (인증 필요)"
echo ""
echo "🔧 테스트 명령어:"
echo "curl http://localhost:8787"
echo "curl -X POST http://localhost:8787/api/auth/register -H 'Content-Type: application/json' -d '{\"email\":\"test@example.com\",\"password\":\"test123\",\"username\":\"testuser\"}'"
echo ""
echo "서버를 종료하려면: Ctrl+C"
echo "========================================="
echo ""
npx wrangler dev src/index.js
