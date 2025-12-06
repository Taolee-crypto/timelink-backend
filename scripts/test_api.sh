#!/bin/bash
BASE_URL="https://timelink-backend.timelink-api.workers.dev"

echo "=== TL Platform API 테스트 ==="

echo "1. 기본 API:"
curl -s "$BASE_URL" | jq '.'

echo -e "\n2. 건강 상태:"
curl -s "$BASE_URL/api/health" | jq '.'

echo -e "\n3. 로그인 테스트:"
curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123"}' | jq '.'

echo -e "\n4. STUDIO 프로젝트:"
curl -s "$BASE_URL/api/studio/projects" | jq '.'

echo -e "\n=== 테스트 완료 ==="
