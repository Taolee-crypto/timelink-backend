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
export default router;
