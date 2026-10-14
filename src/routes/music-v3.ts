import { Hono } from 'hono';
import { authMiddleware } from '../middleware';
import { ensureStorageTables } from '../storage';
import { buildTL3V3FromMp3, parseTL3V3 } from '../tl3v3';
import { parseMp3Segments } from '../mp3-segments';
import type { Env, User } from '../types';

const router = new Hono<{ Bindings: Env; Variables: { user: User } }>();
router.use('*', authMiddleware);

const ID = () => crypto.randomUUID();
const MAX_TITLE = 240;
const MAX_TEXT = 4000;
const providers = new Set(['google_drive', 'onedrive']);
const assetTypes = new Set(['mp3_audio', 'tl3_release_file', 'cover_art', 'lyrics', 'sheet_music', 'other']);

const MAX_TL3_SOURCE_BYTES = 100 * 1024 * 1024;

function trustedLocalAgentUrl(value: unknown): URL | null {
  try {
    const url = new URL(String(value || ''));
    const host = url.hostname.toLowerCase();
    const trustedHost = host === 'agent.timelink.digital' || host.endsWith('.trycloudflare.com');
    const trustedPath = /^\\/local\\/[a-f0-9]{36}$/i.test(url.pathname);
    if (url.protocol !== 'https:' || !trustedHost || !trustedPath
      || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function normalizedHash(value: unknown): string {
  return String(value || '').trim().toLowerCase().replace(/^sha256:/, '');
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}


async function ready(c: any) {
  const row = await c.env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='v3_tracks'"
  ).first();
  if (!row) return c.json({ ok: false, code: 'V3_MUSIC_NOT_INITIALIZED', error: 'V3 music migration has not been applied' }, 503);
  return null;
}

async function hasPocSchema(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='v3_poc_events'").first();
  return !!row;
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
  if(type==='mp3_audio' && !String(object.mime_type||'').toLowerCase().includes('audio')) return c.json({ok:false,error:'Source MP3 Asset must have an audio MIME type'},422);
  const contentHash=String(object.content_hash||'');
  const sizeBytes=Number(object.size||0);
  if(type==='tl3_release_file') {
    if(!String(object.mime_type||'').toLowerCase().includes('octet-stream')) return c.json({ok:false,error:'TL3 Release Asset must be an application/octet-stream object'},422);
    if(!/^(sha256:)?[a-f0-9]{64}$/i.test(contentHash) || !Number.isSafeInteger(sizeBytes) || sizeBytes<=0) return c.json({ok:false,error:'A TL3 conversion requires a SHA-256 hash and positive file size'},422);
  }
  const assetId=ID();
  const statements=[c.env.DB.prepare(`
    INSERT INTO v3_track_assets(id,track_id,asset_type,storage_provider,storage_object_id,content_hash,size_bytes,mime_type,availability_status,created_by)
    VALUES(?,?,?,?,?,?,?,?, 'available',?)
  `).bind(assetId,trackId,type,object.provider,String(object.id),contentHash||null,sizeBytes,object.mime_type,user.id)];
  statements.push(c.env.DB.prepare("UPDATE v3_tracks SET updated_at=datetime('now') WHERE id=?").bind(trackId));
  await c.env.DB.batch(statements);
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
  const mimeType=String(body.mime_type||'').slice(0,120);
  if(type==='tl3_release_file') {
    if(!/^(sha256:)?[a-f0-9]{64}$/i.test(hash) || !Number.isSafeInteger(size) || size<=0) return c.json({ok:false,error:'A TL3 conversion requires a SHA-256 hash and positive file size'},422);
    if(!mimeType.toLowerCase().includes('octet-stream')) return c.json({ok:false,error:'TL3 Release Asset must be an application/octet-stream object'},422);
  }
  // Local Agent URLs are accepted only over HTTPS from the configured TimeLink agent
  // host or Cloudflare quick tunnels. Arbitrary URLs are rejected to prevent SSRF/open redirects.
  let streamUri:string|null=null;
  if(body.public_url) {
    try {
      const u=new URL(String(body.public_url));
      const host=u.hostname.toLowerCase();
      const trustedHost=host==='agent.timelink.digital' || host.endsWith('.trycloudflare.com');
      const tokenPath=/^\/local\/[a-f0-9]{36}$/i.test(u.pathname);
      if(u.protocol!=='https:' || !trustedHost || !tokenPath || u.username || u.password || u.search || u.hash) {
        return c.json({ok:false,error:'public_url must be an HTTPS TimeLink Local Agent file URL'},422);
      }
      streamUri=u.toString();
    } catch { return c.json({ok:false,error:'Invalid public_url'},422); }
  }
  const assetId=ID();
  const availability=streamUri?'available':'local_only';
  const statements=[c.env.DB.prepare(`
    INSERT INTO v3_track_assets(id,track_id,asset_type,storage_provider,storage_uri_ref,content_hash,size_bytes,mime_type,availability_status,created_by)
    VALUES(?,?,?,'local_agent',?,?,?,?,?,?)
  `).bind(assetId,trackId,type,streamUri,hash||null,size,mimeType||null,availability,user.id)];
  await c.env.DB.batch(statements);
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

// POST /tracks/:id/conversions/tl3/build — create an encrypted TL3 container without storing file bytes in D1
router.post('/tracks/:id/conversions/tl3/build', async (c) => {
  const unavailable=await ready(c); if(unavailable) return unavailable;
  const user=c.get('user'),trackId=c.req.param('id');
  if(!await ownedTrack(c.env.DB,trackId,user.id)) return c.json({ok:false,error:'Track not found'},404);
  let body:any; try {body=await c.req.json();} catch {return c.json({ok:false,error:'Invalid JSON body'},400);}
  const sourceAssetId=String(body.source_asset_id||'');
  if(!sourceAssetId) return c.json({ok:false,error:'source_asset_id is required'},422);

  const source=await c.env.DB.prepare(`
    SELECT a.id,a.asset_type,a.storage_provider,a.storage_uri_ref,a.content_hash,a.size_bytes,a.mime_type,a.availability_status,
      m.display_title,COALESCE(m.verified_artist,m.extracted_artist) AS artist
    FROM v3_track_assets a
    JOIN v3_tracks t ON t.id=a.track_id
    LEFT JOIN v3_track_metadata_versions m ON m.track_id=t.id
      AND m.version=(SELECT MAX(mx.version) FROM v3_track_metadata_versions mx WHERE mx.track_id=t.id)
    WHERE a.id=? AND a.track_id=? AND t.owner_user_id=?
  `).bind(sourceAssetId,trackId,user.id).first<any>();
  if(!source||source.asset_type!=='mp3_audio'||source.availability_status!=='available') {
    return c.json({ok:false,error:'An available MP3 source Asset belonging to this Track is required'},422);
  }
  if(source.storage_provider!=='local_agent') {
    return c.json({ok:false,code:'STORAGE_PROVIDER_NOT_READY',error:'TL3 conversion currently requires a source stored through the TimeLink Local Agent'},409);
  }
  const sourceUrl=trustedLocalAgentUrl(source.storage_uri_ref);
  if(!sourceUrl) return c.json({ok:false,error:'The source Asset does not have a valid TimeLink Local Agent URL'},422);
  if(Number(source.size_bytes||0)>MAX_TL3_SOURCE_BYTES) return c.json({ok:false,error:'The MP3 source exceeds the 100 MB conversion limit'},413);
  const expectedSourceHash=normalizedHash(source.content_hash);
  if(!/^[a-f0-9]{64}$/.test(expectedSourceHash)) return c.json({ok:false,error:'The source Asset must have a SHA-256 content hash'},422);
  if(!source.display_title||!source.artist) return c.json({ok:false,error:'Track title and artist metadata are required before conversion'},422);
  const masterSecret=String(c.env.TL3_MASTER_SECRET||'');
  if(!masterSecret) return c.json({ok:false,code:'TL3_CONVERSION_NOT_CONFIGURED',error:'TL3 conversion is not configured on the server'},503);

  const schema=await c.env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='v3_tl3_conversion_jobs'").first();
  if(!schema) return c.json({ok:false,code:'V3_TL3_CONVERSION_NOT_INITIALIZED',error:'V3 TL3 conversion migration has not been applied'},503);
  const recent=await c.env.DB.prepare(`
    SELECT COUNT(*) AS count FROM v3_tl3_conversion_jobs
    WHERE owner_user_id=? AND created_at>=datetime('now','-5 minutes')
  `).bind(user.id).first<any>();
  if(Number(recent?.count||0)>=3) return c.json({ok:false,error:'Too many TL3 conversion attempts. Please wait before trying again.'},429);

  const jobId=ID();
  const licenseReference='v3_'+trackId.replace(/-/g,'')+'_'+crypto.randomUUID().replace(/-/g,'');
  await c.env.DB.prepare(`
    INSERT INTO v3_tl3_conversion_jobs
      (id,track_id,source_asset_id,owner_user_id,license_reference,source_content_hash,status)
    VALUES(?,?,?,?,?,?,'building')
  `).bind(jobId,trackId,sourceAssetId,user.id,licenseReference,expectedSourceHash).run();

  try {
    const upstream=await fetch(sourceUrl.toString(),{redirect:'manual'});
    if(!upstream.ok||upstream.status>=300&&upstream.status<400) throw new Error('The Local Agent could not provide the source MP3');
    const raw=new Uint8Array(await upstream.arrayBuffer());
    if(!raw.byteLength||raw.byteLength>MAX_TL3_SOURCE_BYTES) throw new Error('The source MP3 is empty or exceeds the 100 MB conversion limit');
    const actualSourceHash=await sha256Hex(raw);
    if(actualSourceHash!==expectedSourceHash) throw new Error('The source MP3 content no longer matches its registered SHA-256 hash');
    const segments=parseMp3Segments(raw,5000);
    const durationMs=segments.reduce((total,segment)=>total+segment.durationMs,0);
    const durationSeconds=Math.max(1,Math.round(durationMs/1000));
    const build=await buildTL3V3FromMp3({
      title:String(source.display_title),
      artist:String(source.artist),
      cid:String(user.id),
      name:String(user.id),
      creator_id:Number(user.id),
      mp3Raw:raw,
      segments,
      masterSecret,
      shareId:licenseReference,
      licId:'k_2026_01'
    });
    const outputHash=await sha256Hex(build.data);
    await c.env.DB.prepare(`
      UPDATE v3_tl3_conversion_jobs
      SET status='built',output_content_hash=?,output_size_bytes=?,duration_seconds=?,segment_count=?
      WHERE id=? AND status='building'
    `).bind(outputHash,build.data.byteLength,durationSeconds,segments.length,jobId).run();

    const outputBuffer=new ArrayBuffer(build.data.byteLength);
    new Uint8Array(outputBuffer).set(build.data);
    const headers=new Headers({
      'Content-Type':'application/octet-stream',
      'Content-Disposition':`attachment; filename="TimeLink-${trackId.slice(0,8)}.tl3"`,
      'Cache-Control':'no-store',
      'X-TimeLink-Conversion-Job':jobId,
      'X-TimeLink-License-Reference':licenseReference,
      'X-TimeLink-Duration-Seconds':String(durationSeconds),
      'X-TimeLink-Segment-Count':String(segments.length),
      'X-TimeLink-Source-Hash':actualSourceHash,
      'X-TimeLink-Output-Hash':outputHash,
      'Access-Control-Expose-Headers':'X-TimeLink-Conversion-Job, X-TimeLink-License-Reference, X-TimeLink-Duration-Seconds, X-TimeLink-Segment-Count, X-TimeLink-Source-Hash, X-TimeLink-Output-Hash'
    });
    return new Response(outputBuffer,{status:200,headers});
  } catch(error:any) {
    await c.env.DB.prepare("UPDATE v3_tl3_conversion_jobs SET status='failed' WHERE id=? AND status='building'").bind(jobId).run();
    return c.json({ok:false,error:String(error?.message||'TL3 conversion failed').slice(0,300)},422);
  }
});

// POST /tracks/:id/conversions/tl3/complete — record an explicitly confirmed conversion candidate
// This records pending evidence only. It does not award POC, TL, or TLC.
router.post('/tracks/:id/conversions/tl3/complete', async (c) => {
  const unavailable=await ready(c); if(unavailable) return unavailable;
  const user=c.get('user'),trackId=c.req.param('id');
  if(!await ownedTrack(c.env.DB,trackId,user.id)) return c.json({ok:false,error:'Track not found'},404);
  let body:any; try {body=await c.req.json();} catch {return c.json({ok:false,error:'Invalid JSON body'},400);}
  const sourceAssetId=String(body.source_asset_id||'');
  const outputAssetId=String(body.output_asset_id||'');
  const jobId=String(body.conversion_job_id||'');
  const licenseReference=String(body.license_reference||'');
  if(!sourceAssetId||!outputAssetId||!jobId||!licenseReference||sourceAssetId===outputAssetId) {
    return c.json({ok:false,error:'source_asset_id, output_asset_id, conversion_job_id and license_reference are required'},422);
  }

  const [source,output,job]=await Promise.all([
    c.env.DB.prepare("SELECT id,asset_type,storage_provider,storage_uri_ref,content_hash,availability_status FROM v3_track_assets WHERE id=? AND track_id=?").bind(sourceAssetId,trackId).first<any>(),
    c.env.DB.prepare("SELECT id,asset_type,storage_provider,storage_uri_ref,content_hash,size_bytes,mime_type,availability_status FROM v3_track_assets WHERE id=? AND track_id=?").bind(outputAssetId,trackId).first<any>(),
    c.env.DB.prepare("SELECT id,source_asset_id,owner_user_id,license_reference,source_content_hash,output_asset_id,output_content_hash,output_size_bytes,duration_seconds,segment_count,status FROM v3_tl3_conversion_jobs WHERE id=? AND track_id=?").bind(jobId,trackId).first<any>()
  ]);
  if(!source||source.asset_type!=='mp3_audio'||source.availability_status!=='available') {
    return c.json({ok:false,error:'The source must be an available MP3 source Asset belonging to this Track'},422);
  }
  if(!output||output.asset_type!=='tl3_release_file'||output.availability_status!=='available') {
    return c.json({ok:false,error:'The completed TL3 output must be an available TL3 Asset belonging to this Track'},422);
  }
  if(!job||Number(job.owner_user_id)!==Number(user.id)||job.source_asset_id!==sourceAssetId) {
    return c.json({ok:false,error:'A matching server-created TL3 conversion job is required'},404);
  }
  if(job.license_reference!==licenseReference) return c.json({ok:false,error:'The TL3 license reference does not match the conversion job'},422);
  if(job.status==='completed') {
    if(job.output_asset_id!==outputAssetId) return c.json({ok:false,error:'This conversion job was already completed with a different output Asset'},409);
    const existing=await c.env.DB.prepare("SELECT id,verification_status,contribution_value FROM v3_poc_events WHERE event_key=?").bind('tl3-conversion:'+jobId).first<any>();
    return c.json({ok:true,conversion_recorded:true,duplicate:true,poc_candidate:{id:existing?.id||null,status:existing?.verification_status||'pending',contribution_value:Number(existing?.contribution_value||0)}},200);
  }
  if(job.status!=='built') return c.json({ok:false,error:'The server-side TL3 build has not completed successfully'},409);
  if(source.storage_provider!=='local_agent'||output.storage_provider!=='local_agent') {
    return c.json({ok:false,code:'STORAGE_PROVIDER_NOT_READY',error:'Conversion verification currently requires both Assets to be stored through the TimeLink Local Agent'},409);
  }
  const outputUrl=trustedLocalAgentUrl(output.storage_uri_ref);
  if(!outputUrl) return c.json({ok:false,error:'The TL3 output must have a valid TimeLink Local Agent URL'},422);
  const hash=normalizedHash(output.content_hash);
  const size=Number(output.size_bytes||0);
  if(!/^[a-f0-9]{64}$/.test(hash)||!Number.isSafeInteger(size)||size<=0
    ||!String(output.mime_type||'').toLowerCase().includes('octet-stream')) {
    return c.json({ok:false,error:'The TL3 output requires a SHA-256 hash, positive size, and application/octet-stream MIME type'},422);
  }
  if(hash!==normalizedHash(job.output_content_hash)||size!==Number(job.output_size_bytes)) {
    return c.json({ok:false,error:'The registered TL3 Asset does not match the output produced by the conversion job'},422);
  }
  if(!await hasPocSchema(c.env.DB)) return c.json({ok:false,code:'V3_POC_NOT_INITIALIZED',error:'V3 POC migration must be applied before recording conversion evidence'},503);

  let outputBytes:Uint8Array;
  let header:any;
  try {
    const response=await fetch(outputUrl.toString(),{redirect:'manual'});
    if(!response.ok||response.status>=300&&response.status<400) return c.json({ok:false,error:'The Local Agent could not provide the completed TL3 container'},502);
    outputBytes=new Uint8Array(await response.arrayBuffer());
    if(outputBytes.byteLength!==size) return c.json({ok:false,error:'The stored TL3 container size does not match its registered Asset'},422);
    const actualHash=await sha256Hex(outputBytes);
    if(actualHash!==hash) return c.json({ok:false,error:'The stored TL3 container hash does not match its registered Asset'},422);
    header=parseTL3V3(outputBytes).header;
  } catch(error:any) {
    return c.json({ok:false,error:String(error?.message||'The stored TL3 container could not be verified').slice(0,250)},422);
  }

  if(header.v!==3||header.aead!=='AES-256-GCM'||header.kdf!=='HKDF-SHA-256'
    ||header.share_id!==job.license_reference
    ||normalizedHash(header.hash_mp3)!==normalizedHash(job.source_content_hash)
    ||Number(header.rights?.creator_id)!==Number(user.id)
    ||Number(header.dur_sec)!==Number(job.duration_seconds)
    ||Number(header.mp3?.N)!==Number(job.segment_count)) {
    return c.json({ok:false,error:'The TL3 header does not match the source, creator, license reference, or conversion job'},422);
  }

  const evidence=JSON.stringify({
    conversion_job_id:jobId,
    track_id:trackId,
    source_asset_id:sourceAssetId,
    output_asset_id:outputAssetId,
    license_reference:licenseReference,
    source_content_hash:normalizedHash(job.source_content_hash),
    output_content_hash:hash,
    output_size_bytes:size,
    duration_seconds:Number(job.duration_seconds),
    segment_count:Number(job.segment_count),
    storage_provider:output.storage_provider,
    verified_container_header:true,
    confirmed_by_user_id:user.id
  });
  const eventKey='tl3-conversion:'+jobId;
  const results=await c.env.DB.batch([
    c.env.DB.prepare("UPDATE v3_tl3_conversion_jobs SET status='completed',output_asset_id=?,completed_at=datetime('now') WHERE id=? AND status='built'").bind(outputAssetId,jobId),
    c.env.DB.prepare(`
      INSERT OR IGNORE INTO v3_poc_events
        (id,user_id,event_key,event_type,source,source_reference,base_value,contribution_value,verification_status,formula_version,metadata_json)
      VALUES(?,?,?,?,?,?,0,0,'pending','poc-v1',?)
    `).bind(ID(),String(user.id),eventKey,'tl3_conversion_completed','music_v3',outputAssetId,evidence)
  ]);
  if(!Number(results[0]?.meta?.changes||0)) return c.json({ok:false,error:'Conversion job state changed; reload and try again'},409);
  const event=await c.env.DB.prepare("SELECT id,verification_status,contribution_value FROM v3_poc_events WHERE event_key=?").bind(eventKey).first<any>();
  return c.json({
    ok:true,
    conversion_recorded:true,
    duplicate:false,
    poc_candidate:{id:event?.id||null,status:event?.verification_status||'pending',contribution_value:Number(event?.contribution_value||0)},
    message:'The encrypted TL3 container was verified. POC evidence is pending validation; no POC score, TL, or TLC is issued by this request.'
  },201);
});

// POST /tracks/:id/releases — create a draft TL3 commercial Release
router.post('/tracks/:id/releases', async (c) => {
  const unavailable=await ready(c); if(unavailable) return unavailable;
  const user=c.get('user'),trackId=c.req.param('id');
  if(!await ownedTrack(c.env.DB,user.id,trackId)) return c.json({ok:false,error:'Track not found'},404);
  let body:any; try {body=await c.req.json();} catch {return c.json({ok:false,error:'Invalid JSON body'},400);}
  const type=String(body.release_type||'');
  if(type!=='TL3') return c.json({ok:false,error:'The initial commercial Release type is TL3'},422);
  const price=Number(body.price_tl);
  if(!Number.isSafeInteger(price)||price<=0) return c.json({ok:false,error:'TL3 price must be a positive integer'},422);
  const assetId=String(body.asset_id||'');
  const asset=await c.env.DB.prepare('SELECT id,asset_type,availability_status FROM v3_track_assets WHERE id=? AND track_id=?').bind(assetId,trackId).first<any>();
  if(!asset || asset.asset_type!=='tl3_release_file' || asset.availability_status!=='available') return c.json({ok:false,error:'A matching available TL3 conversion Asset is required before creating a Release'},422);
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
