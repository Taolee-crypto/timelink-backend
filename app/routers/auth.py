from fastapi import APIRouter

router = APIRouter(prefix="/auth", tags=["인증"])

@router.get("/test")
def test_auth():
    return {"message": "Auth router is working"}
