from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
import os
from datetime import datetime

app = FastAPI()

# CORS 허용 (프론트 localhost:3000에서 호출 가능)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "https://f2c84586.pulse-cdz.pages.dev"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")

# 모의 데이터
tracks = []

@app.get("/", response_class=HTMLResponse)
async def root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/tracks")
async def get_tracks():
    return tracks

@app.post("/create")
async def create_track(title: str, creator: str):
    track = {
        "id": len(tracks) + 1,
        "title": title,
        "creator": creator,
        "creator_handle": f"@{creator.lower().replace(' ', '')}",
        "earnings": 0,
        "created_at": datetime.now().isoformat()
    }
    tracks.append(track)
    return {"success": True, "track": track}

@app.post("/boost/{track_id}")
async def boost(track_id: int):
    for t in tracks:
        if t["id"] == track_id:
            t["earnings"] += 100
            return {"success": True, "earnings": t["earnings"]}
    return {"success": False, "message": "Track not found"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)
