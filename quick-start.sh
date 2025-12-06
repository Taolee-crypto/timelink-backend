#!/bin/bash
echo "⚡ 빠른 서버 시작"
echo "================"

# 빠진 파일들 확인
echo "1. 빠진 파일 확인..."
MISSING_FILES=0

check_file() {
  if [ ! -f "$1" ]; then
    echo "⚠️  $1 없음 - 생성 중..."
    touch "$1"
    MISSING_FILES=$((MISSING_FILES + 1))
  fi
}

# 필요한 파일들 확인
check_file "src/api/auth/logout.js"
check_file "src/api/auth/refresh.js"
check_file "src/api/auth/social-auth.js"

for dir in src/api/*/; do
  if [ "$dir" != "src/api/auth/" ]; then
    check_file "${dir}index.js"
  fi
done

if [ $MISSING_FILES -eq 0 ]; then
  echo "✅ 모든 파일이 있습니다"
else
  echo "✅ $MISSING_FILES 개의 파일 생성 완료"
fi

# 서버 시작
echo -e "\n2. 서버 시작..."
echo "🌐 접속: http://localhost:8787"
echo "🔧 테스트: http://localhost:8787/api/test"
echo ""
echo "Ctrl+C로 종료"
echo ""
npx wrangler dev src/index.js
