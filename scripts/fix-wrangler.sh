#!/bin/bash
echo "🔧 Wrangler 문제 해결 시작..."
echo ""

# 1. 캐시 정리
echo "1. Wrangler 캐시 정리..."
rm -rf node_modules/.cache/wrangler
rm -rf ~/.wrangler

# 2. 패키지 재설치
echo "2. 패키지 재설치..."
npm uninstall wrangler
npm install --save-dev wrangler@latest

# 3. 로그인 재시도
echo "3. 새로운 브라우저 창에서 로그인하세요..."
echo "   아래 링크로 이동하여 인증해주세요:"
echo "   https://dash.cloudflare.com/profile/api-tokens"
echo ""
echo "4. 또는 수동으로 토큰 설정:"
read -p "Cloudflare API Token을 입력하세요: " CF_TOKEN
if [ ! -z "$CF_TOKEN" ]; then
    echo "export CLOUDFLARE_API_TOKEN=\"$CF_TOKEN\"" > ~/.wrangler.env
    echo "CLOUDFLARE_ACCOUNT_ID를 입력하세요:"
    echo "(https://dash.cloudflare.com → 오른쪽 사이드바 하단)"
    read -p "Account ID: " CF_ACCOUNT
    echo "export CLOUDFLARE_ACCOUNT_ID=\"$CF_ACCOUNT\"" >> ~/.wrangler.env
    source ~/.wrangler.env
    echo "✅ 토큰 설정 완료"
fi

# 5. 테스트
echo "5. 연결 테스트..."
npx wrangler whoami
