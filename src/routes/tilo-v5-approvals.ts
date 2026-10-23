import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';
const router=new Hono<{Bindings:Env}>();
async function adminId(c:Context<{Bindings:Env}>):Promise<number|null>{
 const token=String(c.req.header('Authorization')||'').replace(/^Bearer\s+/i,'').trim();
 if(!token)return null;
 const payload=await verifyToken(token,c.env.JWT_SECRET).catch(()=>null);
 const id=Number(payload?.sub||0);
 if(!Number.isSafeInteger(id)||id<=0)return null;
 const user=await c.env.DB.prepare('SELECT role FROM users WHERE id=?').bind(id).first<{role:string}>();
 return String(user?.role||'').toLowerCase()==='admin'?id:null;
}
router.get('/settlements',async c=>{
 if(!await adminId(c))return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
 const state=String(c.req.query('state')||'pending');
 if(!['pending','approved','rejected','posted'].includes(state))return c.json({ok:false,error:'INVALID_STATE'},400);
 try{
 const rows=await c.env.DB.prepare(`SELECT settlement_id,country,local_date,creator_id,policy_version,
 evidence_digest,evidence_event_count,previous_monthly_creator_gross_atoms,
 new_creator_gross_atoms,new_platform_share_atoms,state,requested_at,reviewed_at,
 reviewed_by_admin_user_id,posted_transaction_id FROM tilo_v5_settlement_approvals
 WHERE state=? ORDER BY requested_at ASC LIMIT 100`).bind(state).all();
 return c.json({ok:true,settlements:rows.results||[]});
 }catch{return c.json({ok:false,error:'TILO_APPROVAL_SCHEMA_NOT_READY'},503);}
});
router.post('/settlements/:id/review',async c=>{
 const actor=await adminId(c);
 if(!actor)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
 const id=String(c.req.param('id')||'');
 if(!/^[a-zA-Z0-9:_-]{12,160}$/.test(id))return c.json({ok:false,error:'INVALID_SETTLEMENT_ID'},400);
 const body=await c.req.json().catch(()=>null) as {action?:string;note?:string;evidence_digest?:string}|null;
 const action=body?.action;
 if(action!=='approve'&&action!=='reject')return c.json({ok:false,error:'INVALID_REVIEW_ACTION'},400);
 const digest=String(body?.evidence_digest||'').toLowerCase();
 if(!/^[a-f0-9]{64}$/.test(digest))return c.json({ok:false,error:'EVIDENCE_DIGEST_REQUIRED'},400);
 const note=String(body?.note||'').trim();
 if(note.length>1000)return c.json({ok:false,error:'NOTE_TOO_LONG'},400);
 try{
 const record=await c.env.DB.prepare('SELECT state,evidence_digest FROM tilo_v5_settlement_approvals WHERE settlement_id=?')
 .bind(id).first<{state:string;evidence_digest:string}>();
 if(!record)return c.json({ok:false,error:'SETTLEMENT_NOT_FOUND'},404);
 if(record.state!=='pending')return c.json({ok:false,error:'SETTLEMENT_ALREADY_REVIEWED'},409);
 if(record.evidence_digest.toLowerCase()!==digest)return c.json({ok:false,error:'EVIDENCE_DIGEST_MISMATCH'},409);
 const next=action==='approve'?'approved':'rejected';
 const results=await c.env.DB.batch([
 c.env.DB.prepare(`UPDATE tilo_v5_settlement_approvals SET state=?,reviewed_at=datetime('now'),
 reviewed_by_admin_user_id=?,review_note=? WHERE settlement_id=? AND state='pending' AND evidence_digest=?`)
 .bind(next,actor,note||null,id,record.evidence_digest),
 c.env.DB.prepare(`INSERT INTO tilo_v5_settlement_approval_audit
 (settlement_id,action,actor_user_id,note,evidence_digest)
 SELECT settlement_id,?,?,?,evidence_digest FROM tilo_v5_settlement_approvals
 WHERE settlement_id=? AND state=? AND reviewed_by_admin_user_id=?`)
 .bind(action,actor,note||null,id,next,actor)
 ]);
 if(Number(results[0]?.meta?.changes||0)!==1)return c.json({ok:false,error:'SETTLEMENT_REVIEW_CONFLICT'},409);
 return c.json({ok:true,settlement_id:id,state:next,reviewed_by_admin_user_id:actor,
 note:'Approval does not issue TL or post to the economic ledger.'});
 }catch(e){console.error('[TILO_APPROVAL_REVIEW]',e);return c.json({ok:false,error:'TILO_REVIEW_UNAVAILABLE'},503);}
});

/** Prepare a pending candidate from durable verified airtime; never pay TL here. */
router.post('/settlements/prepare',async c=>{
 const actor=await adminId(c);
 if(!actor)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
 const body=await c.req.json().catch(()=>null) as {country?:string;local_date?:string;creator_id?:number}|null;
 const country=String(body?.country||'').toUpperCase();
 const localDate=String(body?.local_date||'');
 const creatorId=Number(body?.creator_id);
 if(!['KR','JP','US','CN','TH','VN'].includes(country)||
    !/^\d{4}-\d{2}-\d{2}$/.test(localDate)||
    !Number.isSafeInteger(creatorId)||creatorId<=0)
   return c.json({ok:false,error:'INVALID_CANDIDATE_SCOPE'},400);
 const zone:Record<string,string>={KR:'Asia/Seoul',JP:'Asia/Tokyo',US:'America/New_York',
   CN:'Asia/Shanghai',TH:'Asia/Bangkok',VN:'Asia/Ho_Chi_Minh'};
 const localDay=(date:Date):string=>{
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:zone[country],year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
  const value=(type:string)=>parts.find(p=>p.type===type)?.value||'';
  return value('year')+'-'+value('month')+'-'+value('day');
 };
 const parsedDate=new Date(localDate+'T00:00:00Z');
 if(!Number.isFinite(parsedDate.getTime())||parsedDate.toISOString().slice(0,10)!==localDate)
   return c.json({ok:false,error:'INVALID_LOCAL_DATE'},400);
 const today=localDay(new Date());
 if(localDate>=today)return c.json({ok:false,error:'LOCAL_DAY_NOT_CLOSED'},409);
 try{
  const rows=await c.env.DB.prepare(`SELECT event_id,started_at,ended_at,audible_ms,
   creator_atoms,platform_atoms,evidence_digest FROM tilo_v5_verified_airtime
   WHERE country=? AND creator_id=? AND local_month=? ORDER BY event_id LIMIT 10001`)
   .bind(country,creatorId,localDate.slice(0,7)).all<any>();
  const events=(rows.results||[]).filter((e:any)=>{
   const day=localDay(new Date(e.started_at));
   const endDay=localDay(new Date(new Date(e.ended_at).getTime()-1));
   return day===localDate&&endDay===localDate;
  });
  if(events.length===0)return c.json({ok:false,error:'NO_VERIFIED_AIRTIME'},404);
  if((rows.results||[]).length>10000)return c.json({ok:false,error:'EVIDENCE_LIMIT_EXCEEDED'},409);
  let creator=0n,platform=0n;
  const parts:string[]=[];
  for(const e of events){
   const ms=BigInt(e.audible_ms);
   const total=ms*3n,creatorPart=total*7n/10n,platformPart=total-creatorPart;
   if(BigInt(e.creator_atoms)!==creatorPart||BigInt(e.platform_atoms)!==platformPart)
     return c.json({ok:false,error:'AIRTIME_AMOUNT_MISMATCH'},409);
   creator+=creatorPart;platform+=platformPart;
   parts.push([e.event_id,e.started_at,e.ended_at,e.audible_ms,e.evidence_digest].join('|'));
  }
  const encoded=new TextEncoder().encode(parts.join('\\n'));
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoded)))
    .map(b=>b.toString(16).padStart(2,'0')).join('');
  const settlementId='tilo:'+country+':'+localDate+':'+creatorId;
  const existing=await c.env.DB.prepare('SELECT settlement_id,state,evidence_digest FROM tilo_v5_settlement_approvals WHERE settlement_id=?')
   .bind(settlementId).first<{settlement_id:string;state:string;evidence_digest:string}>();
  if(existing)return c.json({ok:false,error:'CANDIDATE_ALREADY_EXISTS',state:existing.state,
   evidence_matches:existing.evidence_digest===digest},409);
  // Monthly gross must be derived from earlier approved/postable days, not browser input.
  // Until a serialized monthly watermark exists, candidates after the first day are blocked.
  const prior=await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM tilo_v5_settlement_approvals
   WHERE creator_id=? AND local_month=?`).bind(creatorId,localDate.slice(0,7)).first<{n:number}>();
  if(Number(prior?.n||0)>0)return c.json({ok:false,error:'MONTHLY_WATERMARK_NOT_READY'},409);
  if(creator>BigInt(Number.MAX_SAFE_INTEGER)||platform>BigInt(Number.MAX_SAFE_INTEGER))
   return c.json({ok:false,error:'SETTLEMENT_AMOUNT_OVERFLOW'},409);
  const result=await c.env.DB.batch([
   c.env.DB.prepare(`INSERT OR IGNORE INTO tilo_v5_settlement_approvals
   (settlement_id,country,local_date,creator_id,local_month,policy_version,
   evidence_digest,evidence_event_count,previous_monthly_creator_gross_atoms,
   new_creator_gross_atoms,new_platform_share_atoms)
   VALUES (?,?,?,?,?,'tilo-creator-contribution-v1',?,?,0,?,?)`)
   .bind(settlementId,country,localDate,creatorId,localDate.slice(0,7),digest,
     events.length,Number(creator),Number(platform)),
   c.env.DB.prepare(`INSERT INTO tilo_v5_settlement_approval_audit
   (settlement_id,action,actor_user_id,evidence_digest)
   SELECT settlement_id,'request',?,evidence_digest FROM tilo_v5_settlement_approvals
   WHERE settlement_id=? AND state='pending' AND evidence_digest=?`)
   .bind(actor,settlementId,digest)
  ]);
  if(Number(result[0]?.meta?.changes||0)!==1)
   return c.json({ok:false,error:'CANDIDATE_CONFLICT'},409);
  return c.json({ok:true,settlement_id:settlementId,state:'pending',
   evidence_digest:digest,evidence_event_count:events.length,
   creator_gross_atoms:Number(creator),platform_share_atoms:Number(platform),
   posted:false});
 }catch(e){console.error('[TILO_CANDIDATE_PREPARE]',e);
  return c.json({ok:false,error:'TILO_CANDIDATE_PREPARE_FAILED'},503);}
});

export default router;
