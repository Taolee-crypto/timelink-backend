import { Hono } from 'hono';
import { authMiddleware } from '../middleware';
import { ensureStorageTables } from '../storage';
import type { Env, User } from '../types';

const router = new Hono<{ Bindings: Env; Variables: { user: User } }>();
router.use('*', authMiddleware);

const ID = () => crypto.randomUUID();
const MAX_TITLE = 240;
const MAX_TEXT = 4000;
const providers = new Set(['google_drive', 'onedrive']);
const assetTypes = new Set(['mp3_audio', 'tl3_release_file', 'cover_art', 'lyrics', 'sheet_music', 'other']);

async function ready(c: any) {
  const row = await c.env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='v3_tracks'"
  ).first();
  if (!row) return c.json({ ok: false, code: 'V3_MUSIC_NOT_INITIALIZED', error: 'V3 music migration has not been applied' }, 503);
  return null;
}

async function ownedTrack(db: D1Database, trackId: string, userId: number) {
  return db.prepare('SELECT id, owner_user_id, status, visibility, created_at, updated_at FROM v3_tracks WHERE id=? AND owner_user_id=? AND deleted_at IS NULL')
    .bind(trackId, userId).first<any>();
}

// GET /tracks — creator's own Track catalogue
router.get('/tracks', async (c) => {
  const unavailable = await ready(c); if (unavailable) return unavailable;
  const user = c.get('user');
  const rows = await c.env.DB.prepare(`
    SELECT t.id,t.status,t.visibility,t.created_at,t.updated_at,
      m.display_title,m.verified_artist,m.extracted_artist,m.verified_album,m.extracted_album,
      (SELECT COUNT(*) FROM v3_track_assets a WHERE a.track_id=t.id) AS asset_count,
      (SELECT COUNT(*) FROM v3_track_releases r WHERE r.track_id=t.id) AS release_count
    FROM v3_tracks t
    LEFT JOIN v3_track_metadata_versions m ON m.track_id=t.id
      AND m.version=(SELECT MAX(mx.version) FROM v3_track_metadata_versions mx WHERE mx.track_id=t.id)
    WHERE t.owner_user_id=? AND t.deleted_at IS NULL
    ORDER BY t.updated_at DESC LIMIT 100
  `).bind(user.id).all();
  return c.json({ ok: true, tracks: rows.results || [] });
});

// POST /tracks — create a draft Track and first metadata version
router.post('/tracks', async (c) => {
  const unavailable = await ready(c); if (unavailable) return unavailable;
  const user = c.get('user');
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ ok: false, error: 'Invalid JSON body' }, 400); }
  const title = String(body.title || '').trim();
  if (!title || title.length > MAX_TITLE) return c.json({ ok: false, error: 'title is required (max 240 characters)' }, 422);
  const artist = String(body.artist || '').trim().slice(0, MAX_TITLE);
  const album = String(body.album || '').trim().slice(0, MAX_TITLE);
  const filename = String(body.original_filename || '').trim().slice(0, 255) || title;
  const source = ['id3','filename_fallback','manual','mixed'].includes(body.metadata_source) ? body.metadata_source : 'manual';
  const trackId = ID(), metadataId = ID();
  const result = await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO v3_tracks(id,owner_user_id,status,visibility) VALUES(?,?,'draft','private')").bind(trackId,user.id),
    c.env.DB.prepare(`INSERT INTO v3_track_metadata_versions
      (id,track_id,version,original_filename,extracted_title,extracted_artist,extracted_album,display_title,metadata_source,metadata_status)
      VALUES(?,?,1,?,?,?,?,?,?,'pending_review')`).bind(metadataId,trackId,filename,title,artist,album,title,source)
  ]);
  return c.json({ ok: true, track_id: trackId, metadata_version_id: metadataId, status: 'draft' }, 201);
});

// GET /tracks/:id — owner-only detail; never returns storage credentials or secret material
router.get('/tracks/:id', async (c) => {
  const unavailable = await ready(c); if (unavailable) return unavailable;
  const user = c.get('user'), trackId = c.req.param('id');
  const track = await ownedTrack(c.env.DB,user.id,trackId);
  if (!track) return c.json({ ok: false, error: 'Track not found' }, 404);
  const [metadata,assets,rights,releases,shareplace] = await Promise.all([
    c.env.DB.prepare('SELECT id,version,original_filename,extracted_title,extracted_artist,extracted_album,verified_title,verified_artist,verified_album,display_title,metadata_source,metadata_status,confirmed_at,created_at FROM v3_track_metadata_versions WHERE track_id=? ORDER BY version DESC LIMIT 20').bind(trackId).all(),
    c.env.DB.prepare('SELECT id,asset_type,storage_provider,content_hash,size_bytes,mime_type,availability_status,created_at FROM v3_track_assets WHERE track_id=? ORDER BY created_at DESC').bind(trackId).all(),
    c.env.DB.prepare('SELECT id,claimant_user_id,rights_role,ownership_share_bps,territory,verification_status,terms_version,attested_at,created_at FROM v3_track_rights WHERE track_id=? ORDER BY created_at').bind(trackId).all(),
    c.env.DB.prepare('SELECT id,release_type,version,status,asset_id,price_tl,duration_seconds,format_version,published_at,created_at FROM v3_track_releases WHERE track_id=? ORDER BY created_at DESC').bind(trackId).all(),
    c.env.DB.prepare('SELECT id,category,visibility,featured_state,published_at FROM v3_shareplace_entries WHERE track_id=?').bind(trackId).first()
  ]);
  return c.json({ ok:true, track, metadata:metadata.results||[], assets:assets.results||[], rights:rights.results||[], releases:releases.results||[], shareplace:shareplace||null });
});

// PATCH /tracks/:id/metadata — append a version; never overwrite historical metadata
router.patch('/tracks/:id/metadata', async (c) => {
  const unavailable = await ready(c); if (unavailable) return unavailable;
  const user=c.get('user'), trackId=c.req.param('id');
  if (!await ownedTrack(c.env.DB,user.id,trackId)) return c.json({ok:false,error:'Track not found'},404);
  let body:any; try { body=await c.req.json(); } catch { return c.json({ok:false,error:'Invalid JSON body'},400); }
  const title=String(body.title||'').trim();
  if (!title || title.length>MAX_TITLE) return c.json({ok:false,error:'title is required (max 240 characters)'},422);
  const latest=await c.env.DB.prepare('SELECT COALESCE(MAX(version),0) AS version FROM v3_track_metadata_versions WHERE track_id=?').bind(trackId).first<any>();
  const version=Number(latest?.version||0)+1, metadataId=ID();
  const source=['id3','filename_fallback','manual','mixed'].includes(body.metadata_source)?body.metadata_source:'manual';
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO v3_track_metadata_versions
      (id,track_id,version,original_filename,extracted_title,extracted_artist,extracted_album,verified_title,verified_artist,verified_album,display_title,metadata_source,metadata_status,confirmed_by,confirmed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'confirmed',?,datetime('now'))`)
      .bind(metadataId,trackId,version,String(body.original_filename||title).slice(0,255),String(body.extracted_title||'').slice(0,MAX_TITLE),String(body.extracted_artist||'').slice(0,MAX_TITLE),String(body.extracted_album||'').slice(0,MAX_TITLE),title,String(body.artist||'').slice(0,MAX_TITLE),String(body.album||'').slice(0,MAX_TITLE),title,source,user.id),
    c.env.DB.prepare("UPDATE v3_tracks SET updated_at=datetime('now') WHERE id=? AND owner_user_id=?").bind(trackId,user.id)
  ]);
  return c.json({ok:true,metadata_version_id:metadataId,version});
});

// POST /tracks/:id/assets — link an already registered, user-owned cloud storage object
router.post('/tracks/:id/assets', async (c) => {
  const unavailable=await ready(c); if(unavailable) return unavailable;
  const user=c.get('user'),trackId=c.req.param('id');
  if(!await ownedTrack(c.env.DB,user.id,trackId)) return c.json({ok:false,error:'Track not found'},404);
  let body:any; try {body=await c.req.json();} catch {return c.json({ok:false,error:'Invalid JSON body'},400);}
  const type=String(body.asset_type||'');
  if(!assetTypes.has(type)) return c.json({ok:false,error:'Unsupported asset_type'},422);
  if(!Number.isSafeInteger(Number(body.storage_object_id)) || Number(body.storage_object_id)<=0) {
    return c.json({ok:false,error:'storage_object_id must reference an uploaded, registered storage object'},422);
  }
  await ensureStorageTables(c.env.DB);
  const object=await c.env.DB.prepare(`
    SELECT id,user_id,provider,provider_object_id,mime_type,size,content_hash,status
    FROM storage_objects WHERE id=? AND user_id=? AND status='active'
  `).bind(Number(body.storage_object_id),user.id).first<any>();
  if(!object || !providers.has(String(object.provider))) return c.json({ok:false,error:'Storage object not found or not owned by this creator'},404);
  if(type==='mp3_audio' && !String(object.mime_type||'').toLowerCase().includes('audio')) return c.json({ok:false,error:'MP3 audio asset must have an audio MIME type'},422);
  if(type==='tl3_release_file' && !String(object.mime_type||'').toLowerCase().includes('octet-stream')) return c.json({ok:false,error:'TL3 release asset must be an application/octet-stream object'},422);
  const assetId=ID();
  await c.env.DB.prepare(`
    INSERT INTO v3_track_assets(id,track_id,asset_type,storage_provider,storage_object_id,content_hash,size_bytes,mime_type,availability_status,created_by)
    VALUES(?,?,?,?,?,?,?,?, 'available',?)
  `).bind(assetId,trackId,type,object.provider,String(object.id),object.content_hash,object.size,object.mime_type,user.id).run();
  await c.env.DB.prepare("UPDATE v3_tracks SET updated_at=datetime('now') WHERE id=?").bind(trackId).run();
  return c.json({ok:true,asset_id:assetId,asset_type:type,availability_status:'available'},201);
});

// POST /tracks/:id/assets/local — register a creator-PC source without claiming it is streamable
router.post('/tracks/:id/assets/local', async (c) => {
  const unavailable=await ready(c); if(unavailable) return unavailable;
  const user=c.get('user'),trackId=c.req.param('id');
  if(!await ownedTrack(c.env.DB,user.id,trackId)) return c.json({ok:false,error:'Track not found'},404);
  let body:any; try {body=await c.req.json();} catch {return c.json({ok:false,error:'Invalid JSON body'},400);}
  const type=String(body.asset_type||'');
  if(!['mp3_audio','tl3_release_file','cover_art','other'].includes(type)) return c.json({ok:false,error:'Unsupported local asset_type'},422);
  const hash=String(body.content_hash||'');
  if(hash && !/^(sha256:)?[a-f0-9]{64}$/i.test(hash)) return c.json({ok:false,error:'content_hash must be a SHA-256 hex digest'},422);
  const size=Number(body.size_bytes||0);
  if(!Number.isSafeInteger(size)||size<0) return c.json({ok:false,error:'size_bytes must be a non-negative integer'},422);
  // Local Agent URLs are accepted only over HTTPS from the configured TimeLink agent
  // host or Cloudflare quick tunnels. Arbitrary URLs are rejected to prevent SSRF/open redirects.
  let streamUri:string|null=null;
  if(body.public_url) {
    try {
      const u=new URL(String(body.public_url));
      const host=u.hostname.toLowerCase();
      const trustedHost=host==='agent.timelink.digital' || host.endsWith('.trycloudflare.com');
      const tokenPath=/^\\/local\\/[a-f0-9]{36}$/i.test(u.pathname);
      if(u.protocol!=='https:' || !trustedHost || !tokenPath || u.username || u.password || u.search || u.hash) {
        return c.json({ok:false,error:'public_url must be an HTTPS TimeLink Local Agent file URL'},422);
      }
      streamUri=u.toString();
    } catch { return c.json({ok:false,error:'Invalid public_url'},422); }
  }
  const assetId=ID();
  const availability=streamUri?'available':'local_only';
  await c.env.DB.prepare(`
    INSERT INTO v3_track_assets(id,track_id,asset_type,storage_provider,storage_uri_ref,content_hash,size_bytes,mime_type,availability_status,created_by)
    VALUES(?,?,?,'local_agent',?,?,?,?,?,?)
  `).bind(assetId,trackId,streamUri,hash||null,size,String(body.mime_type||'').slice(0,120)||null,availability,user.id).run();
  return c.json({ok:true,asset_id:assetId,asset_type:type,availability_status:availability,streamable:!!streamUri},201);
});

// POST /tracks/:id/rights — creator's rights declaration; never self-verifies
router.post('/tracks/:id/rights', async (c) => {
  const unavailable=await ready(c); if(unavailable) return unavailable;
  const user=c.get('user'),trackId=c.req.param('id');
  if(!await ownedTrack(c.env.DB,user.id,trackId)) return c.json({ok:false,error:'Track not found'},404);
  let body:any; try {body=await c.req.json();} catch {return c.json({ok:false,error:'Invalid JSON body'},400);}
  const role=String(body.rights_role||'');
  const roles=new Set(['author','composer','lyricist','performer','producer','label','administrator','other']);
  if(!roles.has(role)) return c.json({ok:false,error:'Unsupported rights_role'},422);
  const share=body.ownership_share_bps==null?null:Number(body.ownership_share_bps);
  if(share!==null && (!Number.isInteger(share)||share<0||share>10000)) return c.json({ok:false,error:'ownership_share_bps must be 0..10000'},422);
  const terms=String(body.terms_version||'').trim();
  if(!terms || terms.length>64 || body.attest!==true) return c.json({ok:false,error:'Current terms_version and explicit attest=true are required'},422);
  const id=ID();
  await c.env.DB.prepare(`
    INSERT INTO v3_track_rights(id,track_id,claimant_user_id,rights_role,ownership_share_bps,territory,evidence_ref,verification_status,terms_version,attested_at)
    VALUES(?,?,?,?,?,?,?,'declared',?,datetime('now'))
  `).bind(id,trackId,user.id,role,share,String(body.territory||'').slice(0,64)||null,String(body.evidence_ref||'').slice(0,MAX_TEXT)||null,terms).run();
  return c.json({ok:true,rights_id:id,verification_status:'declared'},201);
});

// POST /tracks/:id/releases — create a draft commercial/free release, no automatic publication
router.post('/tracks/:id/releases', async (c) => {
  const unavailable=await ready(c); if(unavailable) return unavailable;
  const user=c.get('user'),trackId=c.req.param('id');
  if(!await ownedTrack(c.env.DB,user.id,trackId)) return c.json({ok:false,error:'Track not found'},404);
  let body:any; try {body=await c.req.json();} catch {return c.json({ok:false,error:'Invalid JSON body'},400);}
  const type=String(body.release_type||'');
  if(type!=='MP3' && type!=='TL3') return c.json({ok:false,error:'release_type must be MP3 or TL3'},422);
  const price=Number(body.price_tl||0);
  if(!Number.isSafeInteger(price)||price<0||(type==='MP3'&&price!==0)||(type==='TL3'&&price<=0)) return c.json({ok:false,error:'MP3 price must be zero; TL3 price must be a positive integer'},422);
  const assetId=String(body.asset_id||'');
  const asset=await c.env.DB.prepare('SELECT id,asset_type,availability_status FROM v3_track_assets WHERE id=? AND track_id=?').bind(assetId,trackId).first<any>();
  const expected=type==='MP3'?'mp3_audio':'tl3_release_file';
  if(!asset || asset.asset_type!==expected || asset.availability_status!=='available') return c.json({ok:false,error:'A matching available asset is required before creating a release'},422);
  const latest=await c.env.DB.prepare('SELECT COALESCE(MAX(version),0) AS version FROM v3_track_releases WHERE track_id=? AND release_type=?').bind(trackId,type).first<any>();
  const version=Number(latest?.version||0)+1,id=ID();
  const rights=await c.env.DB.prepare("SELECT id,claimant_user_id,rights_role,ownership_share_bps,verification_status,terms_version,attested_at FROM v3_track_rights WHERE track_id=? ORDER BY created_at").bind(trackId).all();
  const snapshot=JSON.stringify({captured_at:new Date().toISOString(),rights:rights.results||[]});
  await c.env.DB.prepare(`
    INSERT INTO v3_track_releases(id,track_id,release_type,version,status,asset_id,rights_snapshot_json,price_tl,duration_seconds,format_version)
    VALUES(?,?,?,?,'draft',?,?,?,?,?)
  `).bind(id,trackId,type,version,assetId,snapshot,price,Number(body.duration_seconds)||null,String(body.format_version||'').slice(0,32)||null).run();
  return c.json({ok:true,release_id:id,release_type:type,version,status:'draft',rights_verified:(rights.results||[]).some((r:any)=>r.verification_status==='verified')},201);
});

// POST /tracks/:id/releases/:releaseId/submit — queue for human rights/release review
router.post('/tracks/:id/releases/:releaseId/submit', async (c) => {
  const unavailable=await ready(c); if(unavailable) return unavailable;
  const user=c.get('user'),trackId=c.req.param('id'),releaseId=c.req.param('releaseId');
  if(!await ownedTrack(c.env.DB,user.id,trackId)) return c.json({ok:false,error:'Track not found'},404);
  const release=await c.env.DB.prepare("SELECT id,status FROM v3_track_releases WHERE id=? AND track_id=?").bind(releaseId,trackId).first<any>();
  if(!release) return c.json({ok:false,error:'Release not found'},404);
  if(release.status!=='draft') return c.json({ok:false,error:'Only draft releases can be submitted'},409);
  const rights=await c.env.DB.prepare("SELECT COUNT(*) AS n FROM v3_track_rights WHERE track_id=? AND claimant_user_id=? AND verification_status IN ('declared','pending','verified')").bind(trackId,user.id).first<any>();
  if(Number(rights?.n||0)<1) return c.json({ok:false,error:'A creator rights declaration is required'},422);
  await c.env.DB.prepare("UPDATE v3_track_releases SET status='ready_for_review',updated_at=datetime('now') WHERE id=? AND track_id=? AND status='draft'").bind(releaseId,trackId).run();
  return c.json({ok:true,release_id:releaseId,status:'ready_for_review',message:'Publication requires separate rights verification and approval'});
});

export default router;
