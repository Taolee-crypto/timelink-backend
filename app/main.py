from fastapi import FastAPI, Form, File, UploadFile
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# CORS 허용 (프론트 모든 포트/도메인 허용)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 개발 중엔 *로 풀어줌 (배포 시 제한)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 모의 데이터 (tracks 배열)
tracks = []

@app.get("/tracks")
def get_tracks():
    return tracks

@app.post("/create")
def create(
    title: str = Form(...),
    creator: str = Form(...),
    file: UploadFile = File(...)
):
    track = {
        "id": len(tracks) + 1,
        "title": title,
        "creator": creator,
        "creator_handle": f"@{creator.lower().replace(' ', '')}",
        "earnings": 0
    }
    tracks.append(track)
    return JSONResponse({"success": True, "track": track})

@app.post("/boost/{track_id}")
def boost(track_id: int):
    for t in tracks:
        if t["id"] == track_id:
            t["earnings"] += 100
            return {"success": True, "earnings": t["earnings"]}
    return {"success": False, "message": "Track not found"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
