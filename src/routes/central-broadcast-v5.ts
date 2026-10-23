import { currentTiloSlot, tiloLocalShow, TILO_ZONES, type TiloCountry } from '../tilo-server-timeline';
import { Hono } from 'hono';
import type { Env } from '../types';
import { calculateCentralBroadcastAtoms } from '../central-broadcast-v5-settlement';

const router = new Hono<{ Bindings: Env }>();
type Song = {file_id:number;share_id:string;title:string;artist:string;genre:string;duration_ms:number;creator_id:number};
/**
 * Only V5 sealed, published, rights-confirmed tracks enter the broadcast
 * planning inventory. This is NOT a public audio download or license endpoint.
 */
router.get('/inventory', async c => {
  try {
    const rows=await c.env.DB.prepare(`
      SELECT v.file_id,v.share_id,v.duration_ms,v.user_id AS creator_id,
        f.title,f.artist,f.genre
      FROM tl3_v5_releases v
      JOIN tl_files f ON f.id=v.file_id
      WHERE v.status='sealed' AND f.shared=1
        AND COALESCE(f.revenue_held,0)=0
        AND LOWER(f.file_type)='audio/tl3'
        AND EXISTS (SELECT 1 FROM tl3_releases r
          WHERE r.file_id=v.file_id AND r.status='released' AND r.rights_confirmed=1)
      ORDER BY v.file_id DESC LIMIT 500
    `).all<Song>();
    const tracks=(rows.results||[]).filter(s=>Number.isSafeInteger(s.file_id)&&s.duration_ms>0);
    return c.json({ok:true,tracks,requires_broadcast_license:true,
      note:'Rights confirmation for SharePlace does not itself grant central broadcast rights.'});
  } catch(e:any){return c.json({ok:false,error:'BROADCAST_INVENTORY_UNAVAILABLE'},503)}
});
/** Read-only calculation: never accepts a browser event as proof of airtime. */
router.get('/settlement-preview', c => {
  const raw=c.req.query('played_ms')||'';
  if(!/^\d{1,12}$/.test(raw))return c.json({ok:false,error:'Invalid played_ms'},400);
  const ms=BigInt(raw);
  if(ms>86400000n)return c.json({ok:false,error:'Preview limited to 24 hours'},400);
  const r=calculateCentralBroadcastAtoms(ms);
  return c.json({ok:true,played_ms:Number(ms),weight:0.3,creator_share:0.7,platform_share:0.3,
    total_atoms:Number(r.totalAtoms),creator_atoms:Number(r.creatorAtoms),
    platform_atoms:Number(r.platformAtoms),atoms_per_tl:10000,posted:false});
});

/**
 * Internal broadcaster state gate. Requires a server-side secret; no browser
 * can use this to impersonate a broadcast worker. No audio is exposed here.
 */
router.get('/service-state', async c => {
  const configured=c.env.CENTRAL_BROADCAST_WORKER_SECRET;
  const provided=c.req.header('X-Central-Broadcast-Secret')||'';
  if(!configured||!provided||provided!==configured)return c.json({ok:false,error:'UNAUTHORIZED'},403);
  const raw=c.req.query('admin_id')||'';
  if(!/^[1-9]\\d{0,14}$/.test(raw))return c.json({ok:false,error:'INVALID_ADMIN_ID'},400);
  const adminId=Number(raw);
  try{
    const serviceId='central-tilo-'+adminId;
    const row=await c.env.DB.prepare('SELECT status FROM central_broadcast_service_accounts WHERE service_id=? AND parent_admin_user_id=?')
      .bind(serviceId,adminId).first<{status:string}>();
    return c.json({ok:true,service_id:serviceId,enabled:row?.status==='active',
      note:'A trusted broadcaster must check file grants and separate broadcast rights before streaming.'});
  }catch(_){return c.json({ok:false,error:'BROADCAST_SCHEMA_NOT_READY'},503)}
});


/**
 * A country-specific broadcast playlist, restricted to a service identity and
 * explicit copyright-holder grants. No audio, decrypt keys or wallet charges.
 */
router.get('/country/:country/playlist', async c => {
  const country=String(c.req.param('country')||'').toUpperCase();
  if(!['KR','JP','US','CN','TH','VN'].includes(country))
    return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
  const adminId=Number(c.req.query('admin_id')||0);
  if(!Number.isSafeInteger(adminId)||adminId<=0)
    return c.json({ok:false,error:'INVALID_ADMIN_ID'},400);
  const configured=c.env.CENTRAL_BROADCAST_WORKER_SECRET;
  const provided=c.req.header('X-Central-Broadcast-Secret')||'';
  if(!configured||!provided||provided!==configured)
    return c.json({ok:false,error:'UNAUTHORIZED'},403);
  const serviceId='central-tilo-'+adminId;
  try {
    const service=await c.env.DB.prepare(`SELECT status FROM central_broadcast_service_accounts
      WHERE service_id=? AND parent_admin_user_id=?`).bind(serviceId,adminId).first<{status:string}>();
    if(service?.status!=='active')return c.json({ok:true,country,enabled:false,tracks:[]});
    const rows=await c.env.DB.prepare(`
      SELECT v.file_id,v.share_id,v.duration_ms,v.user_id AS creator_id,
        f.title,f.artist,f.genre
      FROM central_broadcast_service_file_grants sg
      JOIN tl3_v5_releases v ON v.file_id=sg.file_id
      JOIN tl_files f ON f.id=v.file_id
      WHERE sg.service_id=? AND sg.country=? AND sg.status='active'
        AND (sg.expires_at IS NULL OR sg.expires_at>datetime('now'))
        AND v.status='sealed' AND f.shared=1
        AND COALESCE(f.revenue_held,0)=0
        AND LOWER(f.file_type)='audio/tl3'
        AND EXISTS (SELECT 1 FROM central_broadcast_rights_grants rg
          WHERE rg.file_id=v.file_id AND rg.creator_id=v.user_id
            AND rg.country=? AND rg.status='active'
            AND (rg.expires_at IS NULL OR rg.expires_at>datetime('now')))
        AND EXISTS (SELECT 1 FROM tl3_releases r
          WHERE r.file_id=v.file_id AND r.status='released' AND r.rights_confirmed=1)
      ORDER BY v.file_id DESC LIMIT 200`
    ).bind(serviceId,country,country).all<Song>();
    return c.json({ok:true,country,enabled:true,tracks:rows.results||[],
      note:'Playlist metadata only; broadcaster must obtain an independent, authorized V5 audio session.'});
  }catch(_){return c.json({ok:false,error:'BROADCAST_PLAYLIST_SCHEMA_NOT_READY'},503)}
});


/**
 * Authenticated read-only broadcast clock. Returns metadata only, never TL3
 * bytes or a decryption key. Rights and service grants are checked every time.
 * This is a shared station clock, not evidence of listening or payable airtime.
 */
router.get('/country/:country/now', async c => {
  const country=String(c.req.param('country')||'').toUpperCase();
  if(!(country in TILO_ZONES))return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
  const configured=c.env.CENTRAL_BROADCAST_WORKER_SECRET;
  const supplied=c.req.header('X-Central-Broadcast-Secret')||'';
  if(!configured||supplied!==configured)return c.json({ok:false,error:'UNAUTHORIZED'},403);
  const adminId=Number(c.req.query('admin_id')||0);
  if(!Number.isSafeInteger(adminId)||adminId<=0)return c.json({ok:false,error:'INVALID_ADMIN_ID'},400);
  const serviceId='central-tilo-'+adminId;
  try{
    const service=await c.env.DB.prepare('SELECT status FROM central_broadcast_service_accounts WHERE service_id=? AND parent_admin_user_id=?')
      .bind(serviceId,adminId).first<{status:string}>();
    if(service?.status!=='active')return c.json({ok:true,country,enabled:false,slot:null});
    const rows=await c.env.DB.prepare(`
      SELECT v.file_id,v.duration_ms,f.title,f.artist
      FROM central_broadcast_service_file_grants sg
      JOIN tl3_v5_releases v ON v.file_id=sg.file_id
      JOIN tl_files f ON f.id=v.file_id
      WHERE sg.service_id=? AND sg.country=? AND sg.status='active'
        AND (sg.expires_at IS NULL OR sg.expires_at>datetime('now'))
        AND v.status='sealed' AND f.shared=1
        AND COALESCE(f.revenue_held,0)=0
        AND LOWER(f.file_type)='audio/tl3'
        AND EXISTS (SELECT 1 FROM central_broadcast_rights_grants rg
          WHERE rg.file_id=v.file_id AND rg.creator_id=v.user_id AND rg.country=?
            AND rg.status='active' AND (rg.expires_at IS NULL OR rg.expires_at>datetime('now')))
        AND EXISTS (SELECT 1 FROM tl3_releases r
          WHERE r.file_id=v.file_id AND r.status='released' AND r.rights_confirmed=1)
      ORDER BY v.file_id ASC LIMIT 200
    `).bind(serviceId,country,country).all<{file_id:number;duration_ms:number;title:string;artist:string}>();
    const now=new Date();
    const slot=currentTiloSlot(rows.results||[],now.getTime(),Date.UTC(2026,0,1));
    return c.json({ok:true,country,enabled:true,serverTime:now.toISOString(),timeZone:TILO_ZONES[country as TiloCountry],
      show:tiloLocalShow(country as TiloCountry,now),slot,
      note:'Metadata-only shared clock. Rights can change; revalidate at playback. Not proof of listening or settlement.'});
  }catch(e){console.error('[TILO_TIMELINE]',e);return c.json({ok:false,error:'TIMELINE_UNAVAILABLE'},503);}
});

export default router;
