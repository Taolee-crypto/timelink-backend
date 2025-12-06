#!/bin/bash
echo "⚙️ Wrangler 설정 업데이트"

# wrangler.toml 파일 업데이트
cat > wrangler.toml << 'TOML'
name = "timelink-backend"
main = "src/index.js"
compatibility_date = "2024-12-01"
compatibility_flags = ["nodejs_compat"]

account_id = "a056839cbee168dca5a9439167f98143"

[vars]
API_VERSION = "v1"
JWT_SECRET = "your-jwt-secret-here-change-in-production"

[[d1_databases]]
binding = "DB"
database_name = "timelink-db"
database_id = "your-database-id-here"  # npx wrangler d1 create 후 업데이트

# R2 설정 (선택사항)
[[r2_buckets]]
binding = "MY_BUCKET"
bucket_name = "timelink-storage"
preview_bucket_name = "timelink-storage-preview"

[env.production]
vars = { ENVIRONMENT = "production" }

[env.staging]
vars = { ENVIRONMENT = "staging" }
TOML

echo "✅ wrangler.toml 파일 업데이트 완료"
