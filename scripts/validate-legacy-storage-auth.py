from pathlib import Path

source = Path("src/index.ts").read_text(encoding="utf-8")

checks = {
    "file sync authenticates": "app.post('/api/files/sync', async (c) => {\n  const session=await storageUser(c);" in source,
    "file sync derives owner from JWT": "const userId=Number(session?.sub||0);" in source,
    "chunk init authenticates": "app.post('/api/upload/init',async(c)=>{const session=await storageUser(c)" in source,
    "chunk part authenticates": "app.put('/api/upload/part',async(c)=>{const session=await storageUser(c)" in source,
    "chunk complete authenticates": "app.post('/api/upload/complete',async(c)=>{const session=await storageUser(c)" in source,
    "chunk operations enforce creator namespace": source.count("key.startsWith(`tracks/u${uid}/`)") >= 2,
    "single upload authenticates": "app.post('/api/upload',async(c)=>{const session=await storageUser(c)" in source,
    "single uploads are user-namespaced": "const key=`tracks/u${uid}/${id}.${ext}`" in source,
    "legacy TL upload authenticates": "app.post('/api/upload/tl',async(c)=>{const session=await storageUser(c)" in source,
    "legacy TL upload rejects missing secret": "if(!secret)return c.json({ok:false,error:'TL_SECRET 설정이 필요합니다.'},503)" in source,
    "legacy TL header binds creator to JWT": "creatorId:uid" in source,
    "legacy TL key is creator-namespaced": "key=`tl/u${uid}/${shareId}.tl`" in source,
    "sync no longer creates fallback user": "VALUES (?, ?, 'local_sync', 1000) RETURNING id" not in source,
}
failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + " " + name)
if failed:
    raise SystemExit("Legacy storage security checks failed: " + ", ".join(failed))
print("Legacy storage compatibility/security checks passed.")
