import { currentTiloSlot, tiloLocalShow, TILO_ZONES, type TiloCountry } from '../tilo-server-timeline';
import { Hono } from 'hono';
import { permittedStationTracks } from '../tilo-station';
import { scheduledStationTracks } from '../tilo-station-schedule';
import type { Env } from '../types';
import { calculateCentralBroadcastAtoms, calculateTiloCreatorContributionDelta, tiloLocalSettlementMonth } from '../central-broadcast-v5-settlement';

const router = new Hono<{ Bindings: Env }>();
type Song = {file_id:number;share_id:string;title:string;artist:string;genre:string;duration_ms:number;creator_id:number};

router.get('/stations/:country',async c=>{
  const country=String(c.req.param('country')).toUpperCase();
  if(!Object.hasOwn(TILO_ZONES,country))return c.json({ok:false,error:'UNSUPPORTED_COUNTRY'},400);
  try{
    const now=new Date();
    const tracks=await scheduledStationTracks(c.env.DB,country,now);
    return c.json({ok:true,country,service_enabled:tracks.length>0,
      granted_file_ids:tracks.map(t=>t.file_id),tracks,
      slot:currentTiloSlot(tracks,now.getTime(),Date.UTC(2026,0,1)),serverTime:now.toISOString(),
      show:tiloLocalShow(country as TiloCountry,now),
      scheduling_policy:'promotion_first_random_fallback',
      playback_mode:'authorized_browser_receiver',server_audio_stream:false,posted:false});
  }catch{return c.json({ok:false,error:'BROADCAST_STATION_UNAVAILABLE'},503);}
});
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
        AND EXISTS (SELECT 1 FROM tl_creator_metadata cm WHERE cm.file_id=v.file_id AND cm.user_id=v.user_id AND cm.rights_declared=1 AND cm.rights_role IN ('owner','authorized_agent','licensee') AND cm.rights_scope IN ('master_recording','distribution_license','delegated_scope') AND cm.declaration_status IN ('declared','verified','approved'))
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
  // Settlement candidates are local-calendar-day scoped. Reject events that
  // straddle local midnight before persisting evidence, even within one month.
  const zones:Record<string,string>={KR:'Asia/Seoul',JP:'Asia/Tokyo',
    US:'America/New_York',CN:'Asia/Shanghai',TH:'Asia/Bangkok',VN:'Asia/Ho_Chi_Minh'};
  const localDay=(ms:number):string=>{
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:zones[country],
      year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(ms));
    const v=(key:string)=>parts.find(p=>p.type===key)?.value||'';
    return v('year')+'-'+v('month')+'-'+v('day');
  };
  if(localDay(start)!==localDay(end-1))
    return c.json({ok:false,error:'CROSSES_LOCAL_DAY'},400);
  let localMonth:string;
  try{
    localMonth=tiloLocalSettlementMonth(country as TiloCountry,startedAt);
    if(localMonth!==tiloLocalSettlementMonth(country as TiloCountry,new Date(end-1).toISOString()))
      return c.json({ok:false,error:'CROSSES_LOCAL_MONTH'},400);
  }catch{return c.json({ok:false,error:'INVALID_LOCAL_MONTH'},400);}
  try{
    const service=await c.env.DB.prepare(
      "SELECT status,parent_admin_user_id FROM central_broadcast_service_accounts WHERE service_id=?"
    ).bind(serviceId).first<{status:string;parent_admin_user_id:number}>();
    if(service?.status!=='active')return c.json({ok:false,error:'SERVICE_NOT_ACTIVE'},403);
    // Evidence uses the same V5 eligibility as playback. A premium payment
    // or a legacy grant row is not required for ordinary broadcast music.
    const permitted=await permittedStationTracks(c.env.DB,country,service.parent_admin_user_id);
    const creator=await c.env.DB.prepare('SELECT user_id FROM tl3_v5_releases WHERE file_id=?')
      .bind(fileId).first<{user_id:number}>();
    if(!permitted.some(t=>t.file_id===fileId)||Number(creator?.user_id)!==creatorId)
      return c.json({ok:false,error:'BROADCAST_RIGHTS_NOT_GRANTED'},403);
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
  }catch(e){if(String(e).includes('TILO_AIRTIME_INTERVAL_OVERLAP'))return c.json({ok:false,error:'AIRTIME_INTERVAL_OVERLAP'},409);console.error('[TILO_AIRTIME_RECORD]',e);return c.json({ok:false,error:'AIRTIME_STORAGE_UNAVAILABLE'},503);}
});

/**
 * Internal broadcaster state gate. Requires a server-side secret; no browser
 * can use this to impersonate a broadcast worker. No audio is exposed here.
 */
router.get('/airtime/freshness', async c => {
  const secret=c.env.CENTRAL_BROADCAST_WORKER_SECRET;
  if(!secret||c.req.header('X-Central-Broadcast-Secret')!==secret)
    return c.json({ok:false,error:'UNAUTHORIZED'},403);
  const adminId=Number(c.req.query('admin_id'));
  if(!Number.isSafeInteger(adminId)||adminId<=0)
    return c.json({ok:false,error:'INVALID_ADMIN_ID'},400);
  const serviceId='central-tilo-'+adminId;
  try{
    const service=await c.env.DB.prepare(
      'SELECT status FROM central_broadcast_service_accounts WHERE service_id=? AND parent_admin_user_id=?'
    ).bind(serviceId,adminId).first<{status:string}>();
    if(!service)return c.json({ok:false,error:'SERVICE_NOT_FOUND'},404);
    const latest=await c.env.DB.prepare(
      'SELECT MAX(ended_at) AS last_ended_at FROM tilo_v5_verified_airtime WHERE service_id=?'
    ).bind(serviceId).first<{last_ended_at:string|null}>();
    const last=latest?.last_ended_at||null;
    const age=last?Date.now()-new Date(last).getTime():NaN;
    return c.json({ok:true,service_id:serviceId,enabled:service.status==='active',
      last_airtime_ended_at:last,airtime_stale:!Number.isFinite(age)||age>300000,
      threshold_seconds:300,measurement:'recorded_airtime_only'});
  }catch{return c.json({ok:false,error:'AIRTIME_MONITOR_UNAVAILABLE'},503);}
});

router.get('/service-state', async c => {
  const configured=c.env.CENTRAL_BROADCAST_WORKER_SECRET;
  const provided=c.req.header('X-Central-Broadcast-Secret')||'';
  if(!configured||!provided||provided!==configured)return c.json({ok:false,error:'UNAUTHORIZED'},403);
  const raw=c.req.query('admin_id')||'';
  if(!/^[1-9]\d{0,14}$/.test(raw))return c.json({ok:false,error:'INVALID_ADMIN_ID'},400);
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
        AND EXISTS (SELECT 1 FROM tl_creator_metadata cm WHERE cm.file_id=v.file_id AND cm.user_id=v.user_id AND cm.rights_declared=1 AND cm.rights_role IN ('owner','authorized_agent','licensee') AND cm.rights_scope IN ('master_recording','distribution_license','delegated_scope') AND cm.declaration_status IN ('declared','verified','approved'))
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
        AND EXISTS (SELECT 1 FROM tl_creator_metadata cm WHERE cm.file_id=v.file_id AND cm.user_id=v.user_id AND cm.rights_declared=1 AND cm.rights_role IN ('owner','authorized_agent','licensee') AND cm.rights_scope IN ('master_recording','distribution_license','delegated_scope') AND cm.declaration_status IN ('declared','verified','approved'))
      ORDER BY v.file_id ASC LIMIT 200
    `).bind(serviceId,country,country).all<{file_id:number;duration_ms:number;title:string;artist:string}>();
    const now=new Date();
    const slot=currentTiloSlot(rows.results||[],now.getTime(),Date.UTC(2026,0,1));
    return c.json({ok:true,country,enabled:true,serverTime:now.toISOString(),timeZone:TILO_ZONES[country as TiloCountry],
      show:tiloLocalShow(country as TiloCountry,now),slot,
      note:'Metadata-only shared clock. Rights can change; revalidate at playback. Not proof of listening or settlement.'});
  }catch(e){console.error('[TILO_TIMELINE]',e);return c.json({ok:false,error:'TIMELINE_UNAVAILABLE'},503);}
});


/** Global, station-independent TILO member lounge. No advertising or TL reward. */
async function loungeUser(c:any):Promise<number>{
 const token=(c.req.header('Authorization')||'').replace(/^Bearer\s+/i,'').trim();
 if(!token)return 0;
 const {verifyToken}=await import('../auth');
 const payload=await verifyToken(token,c.env.JWT_SECRET);
 const id=Number(payload?.sub||0);
 return Number.isSafeInteger(id)&&id>0?id:0;
}
router.get('/lounge',async c=>{
 const id=await loungeUser(c);if(!id)return c.json({ok:false,error:'LOGIN_REQUIRED'},401);
 try{
  const cutoff=Math.floor(Date.now()/1000)-90;
  const [members,messages]=await Promise.all([
   c.env.DB.prepare('SELECT u.username FROM tilo_global_presence p JOIN users u ON u.id=p.user_id WHERE p.last_seen_at>=? AND u.is_active=1 ORDER BY p.last_seen_at DESC LIMIT 100').bind(cutoff).all(),
   c.env.DB.prepare('SELECT m.id,u.username,m.message,m.created_at FROM tilo_global_chat m JOIN users u ON u.id=m.user_id ORDER BY m.id DESC LIMIT 60').all()
  ]);
  return c.json({ok:true,members:members.results||[],messages:(messages.results||[]).reverse()});
 }catch(e){console.error('[TILO_LOUNGE]',e);return c.json({ok:false,error:'LOUNGE_UNAVAILABLE'},503);}
});
router.post('/lounge/presence',async c=>{
 const id=await loungeUser(c);if(!id)return c.json({ok:false,error:'LOGIN_REQUIRED'},401);
 try{
  await c.env.DB.prepare('INSERT INTO tilo_global_presence(user_id,last_seen_at) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET last_seen_at=excluded.last_seen_at').bind(id,Math.floor(Date.now()/1000)).run();
  return c.json({ok:true});
 }catch(e){console.error('[TILO_PRESENCE]',e);return c.json({ok:false,error:'PRESENCE_UNAVAILABLE'},503);}
});
router.delete('/lounge/presence',async c=>{
 const id=await loungeUser(c);if(!id)return c.json({ok:false,error:'LOGIN_REQUIRED'},401);
 try{await c.env.DB.prepare('DELETE FROM tilo_global_presence WHERE user_id=?').bind(id).run();return c.json({ok:true});}
 catch(e){return c.json({ok:false,error:'PRESENCE_UNAVAILABLE'},503);}
});
router.post('/lounge/messages',async c=>{
 const id=await loungeUser(c);if(!id)return c.json({ok:false,error:'LOGIN_REQUIRED'},401);
 let body:any;try{body=await c.req.json();}catch{return c.json({ok:false,error:'INVALID_JSON'},400);}
 const message=String(body?.message||'').trim();
 if(!message||message.length>500)return c.json({ok:false,error:'INVALID_MESSAGE'},400);
 try{
  const now=Math.floor(Date.now()/1000);
  const last=await c.env.DB.prepare('SELECT created_at FROM tilo_global_chat WHERE user_id=? ORDER BY id DESC LIMIT 1').bind(id).first<{created_at:number}>();
  if(last&&now-last.created_at<3)return c.json({ok:false,error:'RATE_LIMIT'},429);
  await c.env.DB.prepare('INSERT INTO tilo_global_chat(user_id,message,created_at) VALUES (?,?,?)').bind(id,message,now).run();
  return c.json({ok:true});
 }catch(e){console.error('[TILO_MESSAGE]',e);return c.json({ok:false,error:'MESSAGE_UNAVAILABLE'},503);}
});

export default router;
