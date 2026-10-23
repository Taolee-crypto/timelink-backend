import { currentTiloSlot, tiloLocalShow, TILO_ZONES, type TiloCountry } from '../tilo-server-timeline';
import { Hono } from 'hono';
import type { Env } from '../types';
import { calculateCentralBroadcastAtoms, calculateTiloCreatorContributionDelta, tiloLocalSettlementMonth } from '../central-broadcast-v5-settlement';

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
 * Internal cumulative-settlement preview for a verified monthly rights-holder
 * aggregate. Does not write to the economic ledger or accept public airtime.
 * A server-side broadcaster secret is mandatory.
 */
router.get('/contribution-delta-preview', c => {
  const configured=c.env.CENTRAL_BROADCAST_WORKER_SECRET;
  const provided=c.req.header('X-Central-Broadcast-Secret')||'';
  if(!configured||!provided||provided!==configured)
    return c.json({ok:false,error:'UNAUTHORIZED'},403);
  const previous=String(c.req.query('previous_monthly_gross_atoms')||'');
  const current=String(c.req.query('newly_settled_gross_atoms')||'');
  if(!/^\d{1,15}$/.test(previous)||!/^\d{1,15}$/.test(current))
    return c.json({ok:false,error:'INVALID_ATOMS'},400);
  const before=BigInt(previous),delta=BigInt(current);
  if(before+delta>BigInt(Number.MAX_SAFE_INTEGER))
    return c.json({ok:false,error:'AMOUNT_TOO_LARGE'},400);
  const result=calculateTiloCreatorContributionDelta(before,delta);
  return c.json({
    ok:true,posted:false,policy_version:result.policyVersion,
    next_monthly_gross_atoms:Number(result.nextMonthlyGrossAtoms),
    additional_contribution_atoms:Number(result.additionalContributionAtoms),
    newly_settled_net_atoms:Number(result.newlySettledNetAtoms),
    cumulative_contribution_atoms:Number(result.cumulativeContributionAtoms),
    note:'Read-only preview; caller must independently verify broadcast evidence, rights, local month and ledger watermark.',
  });
});

/**
 * Server-to-server evidence ingestion. Authentication is necessary but not
 * sufficient: the broadcaster must submit completed, audibly verified intervals.
 * Idempotent event IDs prevent duplicate credit evidence. No TL is posted here.
 */
router.post('/airtime/record', async c => {
  const secret=c.env.CENTRAL_BROADCAST_WORKER_SECRET;
  const supplied=c.req.header('X-Central-Broadcast-Secret')||'';
  if(!secret||!supplied||supplied!==secret)
    return c.json({ok:false,error:'UNAUTHORIZED'},403);
  let input:any;
  try {input=await c.req.json();}catch{return c.json({ok:false,error:'INVALID_JSON'},400);}
  const eventId=String(input.event_id||'');
  const serviceId=String(input.service_id||'');
  const country=String(input.country||'').toUpperCase();
  const creatorId=Number(input.creator_id),fileId=Number(input.file_id);
  const audibleMs=Number(input.audible_ms);
  const startedAt=String(input.started_at||''),endedAt=String(input.ended_at||'');
  const evidenceDigest=String(input.evidence_digest||'');
  if(!/^[a-zA-Z0-9:_-]{8,200}$/.test(eventId)||
     !/^central-tilo-[1-9]\d{0,14}$/.test(serviceId)||
     !['KR','JP','US','CN','TH','VN'].includes(country)||
     !Number.isSafeInteger(creatorId)||creatorId<=0||
     !Number.isSafeInteger(fileId)||fileId<=0||
     !Number.isSafeInteger(audibleMs)||audibleMs<=0||audibleMs>3600000||
     !/^[a-fA-F0-9]{64}$/.test(evidenceDigest))
    return c.json({ok:false,error:'INVALID_EVIDENCE'},400);
  const start=new Date(startedAt).getTime(),end=new Date(endedAt).getTime();
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||
     end>Date.now()+60_000||end-start>3600000||audibleMs>end-start)
    return c.json({ok:false,error:'INVALID_AIRTIME_INTERVAL'},400);
  let localMonth:string;
  try{
    localMonth=tiloLocalSettlementMonth(country as TiloCountry,startedAt);
    if(localMonth!==tiloLocalSettlementMonth(country as TiloCountry,new Date(end-1).toISOString()))
      return c.json({ok:false,error:'CROSSES_LOCAL_MONTH'},400);
  }catch{return c.json({ok:false,error:'INVALID_LOCAL_MONTH'},400);}
  try{
    const service=await c.env.DB.prepare(
      "SELECT status FROM central_broadcast_service_accounts WHERE service_id=?"
    ).bind(serviceId).first<{status:string}>();
    if(service?.status!=='active')return c.json({ok:false,error:'SERVICE_NOT_ACTIVE'},403);
    const grant=await c.env.DB.prepare(`
      SELECT 1 AS allowed FROM central_broadcast_service_file_grants sg
      JOIN tl3_v5_releases v ON v.file_id=sg.file_id
      JOIN tl_files f ON f.id=v.file_id
      WHERE sg.service_id=? AND sg.country=? AND sg.file_id=? AND sg.status='active'
        AND (sg.expires_at IS NULL OR sg.expires_at>?)
        AND v.status='sealed' AND v.user_id=? AND f.shared=1
        AND COALESCE(f.revenue_held,0)=0
        AND EXISTS (SELECT 1 FROM central_broadcast_rights_grants rg
          WHERE rg.file_id=? AND rg.creator_id=? AND rg.country=? AND rg.status='active'
            AND (rg.expires_at IS NULL OR rg.expires_at>?))
        AND EXISTS (SELECT 1 FROM tl3_releases r
          WHERE r.file_id=? AND r.status='released' AND r.rights_confirmed=1)
      LIMIT 1
    `).bind(serviceId,country,fileId,endedAt,creatorId,fileId,creatorId,country,endedAt,fileId)
      .first<{allowed:number}>();
    if(!grant)return c.json({ok:false,error:'BROADCAST_RIGHTS_NOT_GRANTED'},403);
    const atoms=calculateCentralBroadcastAtoms(BigInt(audibleMs));
    const inserted=await c.env.DB.prepare(`
      INSERT OR IGNORE INTO tilo_v5_verified_airtime
        (event_id,country,service_id,creator_id,file_id,started_at,ended_at,
         local_month,audible_ms,creator_atoms,platform_atoms,evidence_digest)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(eventId,country,serviceId,creatorId,fileId,startedAt,endedAt,
      localMonth,audibleMs,Number(atoms.creatorAtoms),Number(atoms.platformAtoms),evidenceDigest).run();
    if(!inserted.meta?.changes){
      const existing=await c.env.DB.prepare(
        'SELECT country,service_id,creator_id,file_id,started_at,ended_at,audible_ms,evidence_digest FROM tilo_v5_verified_airtime WHERE event_id=?'
      ).bind(eventId).first<any>();
      if(!existing||existing.country!==country||existing.service_id!==serviceId||
         Number(existing.creator_id)!==creatorId||Number(existing.file_id)!==fileId||
         existing.started_at!==startedAt||existing.ended_at!==endedAt||
         Number(existing.audible_ms)!==audibleMs||existing.evidence_digest!==evidenceDigest)
        return c.json({ok:false,error:'EVENT_ID_CONFLICT'},409);
      return c.json({ok:true,replayed:true,posted:false,event_id:eventId});
    }
    return c.json({ok:true,replayed:false,posted:false,event_id:eventId,
      creator_atoms:Number(atoms.creatorAtoms),platform_atoms:Number(atoms.platformAtoms)});
  }catch(e){console.error('[TILO_AIRTIME_RECORD]',e);return c.json({ok:false,error:'AIRTIME_STORAGE_UNAVAILABLE'},503);}
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
