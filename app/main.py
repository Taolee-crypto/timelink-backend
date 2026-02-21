from fastapi import FastAPI, Depends, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from app.database import get_db, User

app = FastAPI(title="TimeLink MVP Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 프론트 어디서든 호출 가능 (나중엔 도메인 제한)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health_check():
    return {"status": "healthy", "message": "TimeLink Backend is running!"}

@app.get("/tl/balance")
def get_balance(db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == "testuser").first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    return {
        "user_id": user.username,
        "tl_balance": user.tl_balance,
        "tlc_balance": user.tlc_balance
    }

@app.post("/tl/charge")
def charge_tl(amount: int, db: Session = Depends(get_db)):
    if amount <= 0:
        raise HTTPException(status_code=400, detail="Amount must be positive")
    user = db.query(User).filter(User.username == "testuser").first()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    user.tl_balance += amount
    db.commit()
    db.refresh(user)
    return {
        "message": f"{amount} TL 충전 완료!",
        "new_balance": user.tl_balance
    }
