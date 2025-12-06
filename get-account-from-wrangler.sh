#!/bin/bash
echo "🔧 Wrangler에서 Account ID 추출"
echo "================================"

# 1. Wrangler 로그인 시도
echo "1. Wrangler 로그인 상태 확인..."
if npx wrangler whoami &> /dev/null; then
    echo "✅ Wrangler 로그인됨"
    npx wrangler whoami
else
    echo "❌ Wrangler 로그인 필요"
    echo "npx wrangler login 명령어로 로그인하세요"
fi

# 2. Wrangler 설정 파일 확인
WRANGLER_CONFIG="$HOME/.wrangler/config/config.toml"
if [ -f "$WRANGLER_CONFIG" ]; then
    echo -e "\n2. Wrangler 설정 파일 확인: $WRANGLER_CONFIG"
    ACCOUNT_ID=$(grep "account_id" "$WRANGLER_CONFIG" | cut -d'=' -f2 | tr -d ' "')
    if [ ! -z "$ACCOUNT_ID" ]; then
        echo "✅ Account ID 찾음: $ACCOUNT_ID"
        echo "CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID" >> .env
        echo "✅ .env 파일에 저장됨"
    fi
else
    echo "⚠️ Wrangler 설정 파일 없음"
fi

# 3. wrangler.toml 파일 확인
if [ -f "wrangler.toml" ]; then
    echo -e "\n3. 로컬 wrangler.toml 확인"
    ACCOUNT_ID=$(grep "account_id" wrangler.toml | cut -d'=' -f2 | tr -d ' "')
    if [ ! -z "$ACCOUNT_ID" ]; then
        echo "✅ Account ID 찾음: $ACCOUNT_ID"
        echo "CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID" >> .env
    fi
fi

# 결과 출력
echo -e "\n📊 최종 결과:"
if [ -f .env ]; then
    echo ".env 파일:"
    grep CLOUDFLARE .env || echo "Account ID 없음"
else
    echo ".env 파일 없음"
fi
