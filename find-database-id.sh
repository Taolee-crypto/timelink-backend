#!/bin/bash
clear
echo "🔍 DATABASE_ID 찾기 안내"
echo "======================="
echo ""
echo "DATABASE_ID를 찾는 방법:"
echo ""
echo "1. Cloudflare 대시보드 접속:"
echo "   https://dash.cloudflare.com"
echo ""
echo "2. 왼쪽 메뉴에서 'Workers & Pages' 클릭"
echo ""
echo "3. 'D1' 탭 클릭"
echo ""
echo "4. 'timelink-db' 데이터베이스 찾기"
echo ""
echo "5. 데이터베이스 이름을 클릭"
echo ""
echo "6. URL 확인:"
echo "   https://dash.cloudflare.com/XXXXXXXX/d1/database/YYYYYYYY-YYYY-YYYY-YYYY-YYYYYYYYYYYY"
echo "   ↑ 여기서 YYYYYYYY-YYYY-YYYY-YYYY-YYYYYYYYYYYY 부분이 DATABASE_ID"
echo ""
echo "7. 또는 설정 페이지에서 직접 복사"
echo ""
echo "DATABASE_ID 형식:"
echo "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx (32자리, 하이픈 포함)"
echo ""

read -p "DATABASE_ID를 입력하세요: " DB_ID

if [ -z "$DB_ID" ]; then
    echo "❌ DATABASE_ID가 필요합니다."
    echo ""
    echo "임시로 개발을 시작하시려면:"
    echo "DATABASE_ID=00000000-0000-0000-0000-000000000000"
    read -p "임시 ID를 사용하시겠습니까? (y/n): " USE_TEMP
    if [[ "$USE_TEMP" == "y" ]]; then
        DB_ID="00000000-0000-0000-0000-000000000000"
        echo "⚠️ 임시 DATABASE_ID 사용"
    else
        exit 1
    fi
fi

# .env 파일 업데이트
echo "DATABASE_ID=$DB_ID" >> .env
echo "✅ .env 파일에 DATABASE_ID 추가됨: $DB_ID"

# wrangler.toml 파일 업데이트
sed -i "s/database_id = \".*\"/database_id = \"$DB_ID\"/" wrangler.toml
echo "✅ wrangler.toml 파일 업데이트됨"

# JWT_SECRET도 생성
JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || echo "dev-jwt-secret-$(date +%s)")
sed -i "s/JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env
echo "✅ JWT_SECRET 생성됨"

echo ""
echo "🎉 설정 완료!"
echo ""
echo "다음 명령어로 서버를 시작하세요:"
echo "npx wrangler dev src/index.js"
