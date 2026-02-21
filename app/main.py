from fastapi import FastAPI, Form, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000", "https://*.pages.dev"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

tracks = []

@app.get("/tracks")
async def get_tracks():
    return tracks

@app.post("/create")
async def create(title: str = Form(...), creator: str = Form(...), file: UploadFile = File(...)):
    track = {
        "id": len(tracks) + 1,
        "title": title,
        "creator": creator,
        "creator_handle": f"@{creator.lower().replace(' ', '')}",
        "earnings": 0
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
