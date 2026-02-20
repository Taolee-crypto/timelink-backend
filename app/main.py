from fastapi import FastAPI

app = FastAPI(title="TimeLink Backend")

@app.get("/")
def read_root():
    return {"message": "TimeLink Backend is running!"}
