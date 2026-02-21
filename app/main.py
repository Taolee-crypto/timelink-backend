from fastapi import FastAPI, Request, Form, File, UploadFile, HTTPException
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from fastapi.staticfiles import StaticFiles
import hashlib
import os
import uuid
from datetime import datetime
from typing import List, Dict

app = FastAPI(title="Pulse - Time Based Music Economy")
templates = Jinja2Templates(directory="templates")
app.mount("/static", StaticFiles(directory="static"), name="static")

# 모의 데이터 (실제론 DB로 교체)
tracks: List[Dict] = []
uploads_dir = "uploads"
os.makedirs(uploads_dir, exist_ok=True)

def sha256_hash(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()

@app.get("/", response_class=HTMLResponse)
async def pulse_home(request: Request):
    # 최신순 정렬 + 모의 live/earnings
    sorted_tracks = sorted(tracks, key=lambda t: t["created_at"], reverse=True)[:12]
    live_total = sum(t.get("live_count", 0) for t in tracks) + 2847  # mock

    return templates.TemplateResponse(
        "pulse.html",
        {
            "request": request,
            "tracks": sorted_tracks,
            "live_total": live_total
        }
    )

@app.get("/create", response_class=HTMLResponse)
async def create_page(request: Request):
    return templates.TemplateResponse("create.html", {"request": request})

@app.post("/create")
async def create_track(
    title: str = Form(...),
    creator: str = Form(...),
    file: UploadFile = File(...)
):
    if not file.content_type.startswith(("audio/", "video/")):
        raise HTTPException(400, "Audio or Video 파일만 업로드 가능")

    content = await file.read()
    file_hash = sha256_hash(content)

    # 파일 저장
    ext = file.filename.split(".")[-1]
    filename = f"{uuid.uuid4()}.{ext}"
    file_path = os.path.join(uploads_dir, filename)
    with open(file_path, "wb") as f:
        f.write(content)

    # 블록체인 해시 (mock)
    blockchain_hash = "0x" + hashlib.sha256(
        (title + creator + str(datetime.now().timestamp())).encode()
    ).hexdigest()[:40]

    new_track = {
        "id": len(tracks) + 1,
        "title": title,
        "creator": creator,
        "creator_handle": f"@{creator.lower().replace(' ', '')}",
        "live_count": 0,
        "earnings": 0.0,
        "created_at": datetime.now().isoformat(),
        "file_path": file_path,
        "file_hash": file_hash,
        "blockchain_hash": blockchain_hash,
        "ipfs_cid": f"mock_ipfs_{uuid.uuid4().hex[:8]}"  # 실제 IPFS 나중에
    }

    tracks.append(new_track)
    return RedirectResponse("/", status_code=303)

@app.post("/boost/{track_id}")
async def boost_track(track_id: int):
    for t in tracks:
        if t["id"] == track_id:
            t["earnings"] += 100
            t["live_count"] += 1
            return {"success": True, "earnings": t["earnings"]}
    raise HTTPException(404, "Track not found")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
