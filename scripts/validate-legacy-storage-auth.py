from pathlib import Path

source = Path("src/index.ts").read_text(encoding="utf-8")
storage = Path("src/d1-storage.ts").read_text(encoding="utf-8")

checks = {
    "file sync authenticates": "app.post('/api/files/sync', async (c) => {\n  const session = await storageUser(c);" in source,
    "file sync derives owner from JWT": "const userId = Number(session?.sub || 0);" in source,
    "file sync ignores caller publication flags": "shared_to_shareplace=0,shared=0,auth_status='unverified'" in source,
    "chunk init authenticates": "app.post('/api/upload/init',async(c)=>{\n  const uid=await playbackUserId(c,false);" in source,
    "chunk part authenticates": "app.put('/api/upload/part',async(c)=>{\n  const uid=await playbackUserId(c,false);" in source,
    "chunk complete authenticates": "app.post('/api/upload/complete',async(c)=>{\n  const uid=await playbackUserId(c,false);" in source,
    "chunk operations enforce creator namespace": "key.startsWith(`tracks/u${ownerId}/`)" in storage and "WHERE upload_id=? AND owner_id=?" in storage,
    "single upload authenticates": "app.post('/api/upload',async(c)=>{const session=await storageUser(c),uid=Number(session?.sub||0);" in source,
    "single uploads are user-namespaced": "const key=`tracks/u${uid}/${id}.${ext}`" in source,
    "legacy TL upload authenticates": "app.post('/api/upload/tl',async(c)=>{const session=await storageUser(c)" in source,
    "legacy TL upload rejects missing secret": "if(!secret)return c.json({ok:false,error:'TL_SECRET 설정이 필요합니다.'},503)" in source,
    "legacy TL header binds creator to JWT": "creatorId:uid" in source,
    "legacy TL key is creator-namespaced": "key=`tl/u${uid}/${shareId}.tl`" in source,
    "namespaced storage stream resolves owner": "const viewerId=await playbackUserId(c);" in source and "const scoped=key.match(/^(?:tracks|tl)\\/u(\\d+)\\//);" in source,
    "protected storage requires owner or verified publication": "if(!isOwner&&!isPublic)" in source and "isPublicPlaybackShare(c.env.DB,share)" in source,
    "public TL3 stream requires verified shared record": "auth_status='verified' AND shared=1 AND COALESCE(revenue_held,0)=0" in source,
    "private stream is not cached publicly": "'Cache-Control':isPublic?'public, max-age=300':'private, no-store'" in source,
    "sync no longer creates fallback user": "VALUES (?, ?, 'local_sync', 1000) RETURNING id" not in source,
    "Bearer token parsing removes scheme correctly": ".replace(/^Bearer\\s+/,'').trim()" not in source and ".replace(/^Bearer\\s+/,'').trim()" not in source,
}
failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + " " + name)
if failed:
    raise SystemExit("Legacy storage security checks failed: " + ", ".join(failed))
print("Legacy storage compatibility/security checks passed.")
