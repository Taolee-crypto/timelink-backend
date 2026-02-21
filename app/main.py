from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="TimeLink MVP Backend")

# CORS 설정 (프론트엔드 연결용)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 나중엔 timelink.digital로 제한
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health_check():
    return {"status": "healthy", "message": "TimeLink Backend is running!"}

@app.get("/tl/balance")
def get_balance():
    # 가짜 데이터 (나중 DB 연결)
    return {"user_id": "testuser", "tl_balance": 10000, "tlc_balance": 5.25}
