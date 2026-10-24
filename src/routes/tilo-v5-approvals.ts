import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';
import { planTiloV5LedgerPosting } from '../tilo-v5-ledger-posting-plan';
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
  // Only POSTED settlements are recognized as paid monthly gross.
  // Reject gaps, out-of-order days and any unsettled prior candidate.
  // The monthly progression is creator-wide, across all TILO countries.
  const priorRows=await c.env.DB.prepare(`SELECT settlement_id,country,local_date,state,
   previous_monthly_creator_gross_atoms,new_creator_gross_atoms
   FROM tilo_v5_settlement_approvals WHERE creator_id=? AND local_month=?
   ORDER BY local_date,country LIMIT 10001`)
   .bind(creatorId,localDate.slice(0,7)).all<{
    settlement_id:string;country:string;local_date:string;state:string;
    previous_monthly_creator_gross_atoms:number;new_creator_gross_atoms:number;
   }>();
  if((priorRows.results||[]).length>10000)
   return c.json({ok:false,error:'MONTHLY_HISTORY_LIMIT_EXCEEDED'},409);
  let previousGross=0n;
  for(const p of priorRows.results||[]){
   if(p.local_date>=localDate)
    return c.json({ok:false,error:'MONTHLY_SETTLEMENT_OUT_OF_ORDER'},409);
   if(p.state!=='posted')
    return c.json({ok:false,error:'PRIOR_SETTLEMENT_NOT_POSTED'},409);
   if(BigInt(p.previous_monthly_creator_gross_atoms)!==previousGross)
    return c.json({ok:false,error:'MONTHLY_WATERMARK_MISMATCH'},409);
   previousGross+=BigInt(p.new_creator_gross_atoms);
  }
  if(previousGross+creator>BigInt(Number.MAX_SAFE_INTEGER))
   return c.json({ok:false,error:'MONTHLY_GROSS_OVERFLOW'},409);
  if(creator>BigInt(Number.MAX_SAFE_INTEGER)||platform>BigInt(Number.MAX_SAFE_INTEGER))
   return c.json({ok:false,error:'SETTLEMENT_AMOUNT_OVERFLOW'},409);
  const result=await c.env.DB.batch([
   c.env.DB.prepare(`INSERT OR IGNORE INTO tilo_v5_settlement_approvals
   (settlement_id,country,local_date,creator_id,local_month,policy_version,
   evidence_digest,evidence_event_count,previous_monthly_creator_gross_atoms,
   new_creator_gross_atoms,new_platform_share_atoms)
   VALUES (?,?,?,?,?,'tilo-creator-contribution-v1',?,?,?,?,?)`)
   .bind(settlementId,country,localDate,creatorId,localDate.slice(0,7),digest,
     events.length,Number(previousGross),Number(creator),Number(platform)),
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
   previous_monthly_creator_gross_atoms:Number(previousGross),
   creator_gross_atoms:Number(creator),platform_share_atoms:Number(platform),
   posted:false});
 }catch(e){console.error('[TILO_CANDIDATE_PREPARE]',e);
  return c.json({ok:false,error:'TILO_CANDIDATE_PREPARE_FAILED'},503);}
});


/** Admin-only, read-only funding readiness. Never posts ledger entries. */
router.get('/settlements/:id/posting-readiness',async c=>{
 const actor=await adminId(c);
 if(!actor)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
 const id=String(c.req.param('id')||'');
 if(!/^[a-zA-Z0-9:_-]{12,160}$/.test(id))
  return c.json({ok:false,error:'INVALID_SETTLEMENT_ID'},400);
 try{
  const row=await c.env.DB.prepare(`SELECT state,evidence_digest,policy_version,
   previous_monthly_creator_gross_atoms,new_creator_gross_atoms,new_platform_share_atoms,
   posted_transaction_id FROM tilo_v5_settlement_approvals WHERE settlement_id=?`)
   .bind(id).first<{
    state:string;evidence_digest:string;policy_version:string;
    previous_monthly_creator_gross_atoms:number;new_creator_gross_atoms:number;
    new_platform_share_atoms:number;posted_transaction_id:string|null;
   }>();
  if(!row)return c.json({ok:false,error:'SETTLEMENT_NOT_FOUND'},404);
  if(row.state!=='approved')return c.json({ok:true,ready:false,
   blockers:['SETTLEMENT_NOT_APPROVED'],state:row.state,posted:false});
  const plan=planTiloV5LedgerPosting(
   BigInt(row.previous_monthly_creator_gross_atoms),
   BigInt(row.new_creator_gross_atoms),BigInt(row.new_platform_share_atoms));
  const funding=await c.env.DB.prepare(`SELECT b.available_atoms FROM v3_economy_accounts a
   JOIN v3_economy_balances b ON b.account_id=a.id
   WHERE a.owner_type='platform' AND a.owner_id='timelink' AND a.asset_code='TL'
   AND a.bucket='tilo_broadcast_funding' AND a.status='active'`)
   .first<{available_atoms:number}>();
  const available=BigInt(funding?.available_atoms||0);
  const blockers:string[]=[];
  if(row.policy_version!==plan.policyVersion)blockers.push('POLICY_VERSION_MISMATCH');
  if(available<plan.platformFundingAtoms)blockers.push('INSUFFICIENT_PLATFORM_FUNDING');
  // Recompute the exact candidate snapshot from stored verified events.
  // Fail closed if evidence changed, intervals cross local midnight or the
  // country/month event set is too large for this bounded audit.
  const scope=await c.env.DB.prepare(`SELECT country,local_date,creator_id,evidence_event_count,
   new_creator_gross_atoms,new_platform_share_atoms FROM tilo_v5_settlement_approvals
   WHERE settlement_id=?`).bind(id).first<{
    country:string;local_date:string;creator_id:number;evidence_event_count:number;
    new_creator_gross_atoms:number;new_platform_share_atoms:number;
   }>();
  if(!scope)throw new Error('SETTLEMENT_SCOPE_MISSING');
  const zones:Record<string,string>={KR:'Asia/Seoul',JP:'Asia/Tokyo',
   US:'America/New_York',CN:'Asia/Shanghai',TH:'Asia/Bangkok',VN:'Asia/Ho_Chi_Minh'};
  const formatter=new Intl.DateTimeFormat('en-US',{timeZone:zones[scope.country],
   year:'numeric',month:'2-digit',day:'2-digit'});
  const day=(d:Date)=>{
   const parts=formatter.formatToParts(d);
   const v=(k:string)=>parts.find(p=>p.type===k)?.value||'';
   return v('year')+'-'+v('month')+'-'+v('day');
  };
  const evidence=await c.env.DB.prepare(`SELECT event_id,started_at,ended_at,audible_ms,
   creator_atoms,platform_atoms,evidence_digest FROM tilo_v5_verified_airtime
   WHERE country=? AND creator_id=? AND local_month=? ORDER BY event_id LIMIT 10001`)
   .bind(scope.country,scope.creator_id,scope.local_date.slice(0,7)).all<{
    event_id:string;started_at:string;ended_at:string;audible_ms:number;
    creator_atoms:number;platform_atoms:number;evidence_digest:string;
   }>();
  let count=0,gross=0n,platform=0n;
  const pieces:string[]=[];
  if((evidence.results||[]).length>10000)blockers.push('EVIDENCE_LIMIT_EXCEEDED');
  else for(const e of evidence.results||[]){
   const start=new Date(e.started_at).getTime(),end=new Date(e.ended_at).getTime();
   if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start){
    blockers.push('INVALID_EVIDENCE_INTERVAL');break;
   }
   const startDay=day(new Date(start)),endDay=day(new Date(end-1));
   if(startDay!==scope.local_date&&endDay!==scope.local_date)continue;
   if(startDay!==scope.local_date||endDay!==scope.local_date){
    blockers.push('CROSSES_LOCAL_DAY');break;
   }
   const ms=BigInt(e.audible_ms);
   const total=ms*3n,creatorPart=total*7n/10n,platformPart=total-creatorPart;
   if(BigInt(e.creator_atoms)!==creatorPart||BigInt(e.platform_atoms)!==platformPart){
    blockers.push('AIRTIME_AMOUNT_MISMATCH');break;
   }
   count++;gross+=creatorPart;platform+=platformPart;
   pieces.push([e.event_id,e.started_at,e.ended_at,e.audible_ms,e.evidence_digest].join('|'));
  }
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
   new TextEncoder().encode(pieces.join('\\n')))))
   .map(b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!==row.evidence_digest||count!==scope.evidence_event_count||
     gross!==BigInt(scope.new_creator_gross_atoms)||
     platform!==BigInt(scope.new_platform_share_atoms))
   blockers.push('EVIDENCE_SNAPSHOT_CHANGED');
  // Recheck every broadcast source against current grants and release state.
  // This is intentionally stricter than checking rights only at ingestion.
  const rights=await c.env.DB.prepare(`SELECT COUNT(*) AS denied
   FROM tilo_v5_verified_airtime e
   LEFT JOIN central_broadcast_service_accounts svc
     ON svc.service_id=e.service_id AND svc.status='active'
   LEFT JOIN central_broadcast_service_file_grants sg
     ON sg.service_id=e.service_id AND sg.country=e.country
     AND sg.file_id=e.file_id AND sg.status='active'
     AND (sg.expires_at IS NULL OR sg.expires_at>datetime('now'))
   LEFT JOIN central_broadcast_rights_grants rg
     ON rg.file_id=e.file_id AND rg.creator_id=e.creator_id
     AND rg.country=e.country AND rg.status='active'
     AND (rg.expires_at IS NULL OR rg.expires_at>datetime('now'))
   LEFT JOIN tl3_v5_releases v ON v.file_id=e.file_id
     AND v.user_id=e.creator_id AND v.status='sealed'
   LEFT JOIN tl_files f ON f.id=e.file_id AND f.shared=1
     AND COALESCE(f.revenue_held,0)=0
   WHERE e.country=? AND e.creator_id=? AND e.local_month=?
     AND (svc.service_id IS NULL OR sg.service_id IS NULL
       OR rg.file_id IS NULL OR v.file_id IS NULL OR f.id IS NULL
       OR NOT EXISTS (SELECT 1 FROM tl3_releases tr
         WHERE tr.file_id=e.file_id AND tr.status='released'
           AND tr.rights_confirmed=1))`)
   .bind(scope.country,scope.creator_id,scope.local_date.slice(0,7))
   .first<{denied:number}>();
  if(Number(rights?.denied||0)>0)blockers.push('BROADCAST_RIGHTS_REVOKED_OR_EXPIRED');
  // Migration presence must be verified on the actual production D1.
  blockers.push('ATOMIC_GUARD_DEPLOYMENT_UNVERIFIED','ATOMIC_POSTING_NOT_ENABLED');
  return c.json({ok:true,ready:false,state:row.state,posted:false,
   evidence_digest:row.evidence_digest,policy_version:plan.policyVersion,
   required_funding_atoms:Number(plan.platformFundingAtoms),
   available_funding_atoms:Number(available),
   creator_net_atoms:Number(plan.creatorNetAtoms),
   development_contribution_atoms:Number(plan.developmentContributionAtoms),
   blockers});
 }catch(e){console.error('[TILO_POSTING_READINESS]',e);
  return c.json({ok:false,error:'POSTING_READINESS_UNAVAILABLE'},503);}
});

export default router;
