# main.py
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles

app = FastAPI()
templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")

# 모의 데이터 (나중에 DB로 교체)
tracks = [
    {"id": 1, "title": "Midnight Rain", "creator": "@soyeon", "live": 1842, "earnings": 4920},
    {"id": 2, "title": "Dawn Breaker", "creator": "@minho", "live": 932, "earnings": 2780},
    # ... 더 추가
]

@app.get("/", response_class=HTMLResponse)
async def pulse_home(request: Request):
    return templates.TemplateResponse(
        "pulse.html",
        {"request": request, "tracks": tracks}
    )

# Boost API 예시 (HTMX로 호출)
@app.post("/boost/{track_id}")
async def boost_track(track_id: int):
    # 실제로는 DB 업데이트 + 웹소켓 브로드캐스트
    return {"message": f"Boosted track {track_id} +100 TL!"}
