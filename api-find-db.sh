#!/bin/bash
echo "🌐 Cloudflare API로 DATABASE_ID 조회"
echo "=================================="

# 1. API 토큰 확인
echo "1. API 토큰 확인..."
TOKEN_FILE="$HOME/.wrangler/config/config.toml"
if [ -f "$TOKEN_FILE" ]; then
    API_TOKEN=$(grep "api_token" "$TOKEN_FILE" | cut -d'=' -f2 | tr -d ' "')
    if [ ! -z "$API_TOKEN" ]; then
        echo "✅ API 토큰 발견"
    else
        echo "❌ API 토큰 없음"
        exit 1
    fi
else
    echo "❌ 설정 파일 없음"
    exit 1
fi

# 2. Account ID 확인
ACCOUNT_ID="a056839cbee168dca5a9439167f98143"
echo "Account ID: $ACCOUNT_ID"

# 3. API 호출
echo -e "\n2. API 호출로 데이터베이스 목록 가져오기..."
RESPONSE=$(curl -s -X GET "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/d1/database" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json")

echo "API 응답:"
echo "$RESPONSE" | python -m json.tool 2>/dev/null || echo "$RESPONSE"

# 4. timelink-db 찾기
echo -e "\n3. timelink-db 검색..."
if echo "$RESPONSE" | grep -q "timelink-db"; then
    echo "✅ timelink-db 발견!"
    
    # JSON에서 ID 추출 (간단한 방법)
    DB_ID=$(echo "$RESPONSE" | grep -o '"id":"[^"]*"[^}]*"name":"timelink-db"' | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
    
    if [ ! -z "$DB_ID" ]; then
        echo "🎉 DATABASE_ID: $DB_ID"
        echo ""
        echo "📝 .env 파일에 저장하려면:"
        echo "echo 'DATABASE_ID=$DB_ID' >> .env"
        echo ""
        read -p ".env 파일에 저장할까요? (y/n): " SAVE
        if [[ "$SAVE" == "y" ]]; then
            echo "DATABASE_ID=$DB_ID" >> .env
            echo "✅ 저장 완료!"
        fi
    else
        echo "⚠️ ID 추출 실패, 수동으로 찾아야 합니다"
    fi
else
    echo "❌ timelink-db를 찾을 수 없습니다"
    echo "데이터베이스가 생성되었는지 확인하세요"
fi
