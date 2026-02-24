import pytest


@pytest.mark.asyncio
async def test_register(client):
    resp = await client.post("/api/v1/auth/register", json={
        "email": "new@timelink.io",
        "username": "newuser",
        "password": "password123",
    })
    assert resp.status_code == 201
    data = resp.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"


@pytest.mark.asyncio
async def test_register_duplicate_email(client):
    payload = {"email": "dup@timelink.io", "username": "user1", "password": "pass123"}
    await client.post("/api/v1/auth/register", json=payload)
    resp = await client.post("/api/v1/auth/register", json={**payload, "username": "user2"})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_login(auth_client):
    resp = await auth_client.get("/api/v1/users/me")
    assert resp.status_code == 200
    data = resp.json()
    assert data["email"] == "test@timelink.io"
    assert data["tl_balance"] == 1000.0   # 가입 보너스


@pytest.mark.asyncio
async def test_wallet(auth_client):
    resp = await auth_client.get("/api/v1/users/me/wallet")
    assert resp.status_code == 200
    wallet = resp.json()
    assert wallet["tl_balance"] == 1000.0
    assert wallet["poc_index"] == 1.0
    assert wallet["account_forfeited"] is False


@pytest.mark.asyncio
async def test_health(client):
    resp = await client.get("/api/v1/health")
    assert resp.status_code == 200
    assert resp.json()["status"] == "ok"
