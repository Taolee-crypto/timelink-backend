import requests
import json

token = "k_NqCBNHJAOccU8HG1ZvE_GpvXwnAq_PDzytdHaQ"
account_id = "a056839cbee168dca5a9439167f98143"

headers = {
    "Authorization": f"Bearer {token}",
    "Content-Type": "application/json"
}

print("1. 토큰 검증:")
resp = requests.get("https://api.cloudflare.com/client/v4/user/tokens/verify", headers=headers)
print(json.dumps(resp.json(), indent=2))

print("\n2. Workers 목록 확인 (권한 테스트):")
resp = requests.get(f"https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts", headers=headers)
print(f"상태 코드: {resp.status_code}")
print(json.dumps(resp.json(), indent=2))

print("\n3. 새 Worker 생성 테스트:")
worker_code = 'addEventListener("fetch", e => e.respondWith(new Response("test")))'
resp = requests.put(
    f"https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/test-permission-check",
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/javascript"},
    data=worker_code
)
print(f"상태 코드: {resp.status_code}")
print(json.dumps(resp.json(), indent=2))
