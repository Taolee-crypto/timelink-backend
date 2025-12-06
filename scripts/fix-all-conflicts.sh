#!/bin/bash
echo "🔧 모든 Git 충돌 해결"
echo "===================="

cd /c/Users/win11/timelink-backend

# 모든 충돌 파일 찾기
echo "충돌 파일 검색..."
CONFLICT_FILES=$(grep -r -l "<<<<<<<" . 2>/dev/null)

if [ -z "$CONFLICT_FILES" ]; then
    echo "✅ 충돌 파일 없음"
else
    echo "⚠️  발견된 충돌 파일:"
    echo "$CONFLICT_FILES"
    
    # 각 파일 정리
    for file in $CONFLICT_FILES; do
        echo "처리 중: $file"
        
        # 파일 확장자에 따라 다른 처리
        if [[ "$file" == *.toml ]]; then
            # wrangler.toml 재생성
            cat > "$file" << 'TOML'
name = "timelink-backend"
main = "src/index.js"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

account_id = "a056839cbee168dca5a9439167f98143"

[vars]
API_VERSION = "v1"
JWT_SECRET = "dev-jwt-secret-change-in-production"

[[d1_databases]]
binding = "DB"
database_name = "timelink-db"
database_id = "cf631397-ed92-4d21-b989-f3b3cedb7ae4"

[env.production]
name = "timelink-backend-prod"
vars = { ENVIRONMENT = "production" }

[env.staging]
name = "timelink-backend-staging"
vars = { ENVIRONMENT = "staging" }
TOML
            echo "  → wrangler.toml 재생성"
            
        elif [[ "$file" == *.js ]] && [[ "$file" == *index.js ]]; then
            # index.js는 위에서 이미 처리
            echo "  → 이미 처리됨"
            
        else
            # 일반 파일: 충돌 표시 제거
