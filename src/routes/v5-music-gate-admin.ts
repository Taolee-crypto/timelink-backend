import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';
import { decideInitialGate } from '../v5-ai-music-gate-automation-policy';

const router = new Hono<{ Bindings: Env }>();

router.get('/reviews', async (c) => {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer /i, '').trim();
  const payload = token ? await verifyToken(token, c.env.JWT_SECRET).catch(() => null) : null;
  const id = Number(payload?.sub || 0);
  if (!Number.isSafeInteger(id) || id <= 0) return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const user = await c.env.DB.prepare('SELECT role,is_active FROM users WHERE id=?').bind(id).first<{role:string;is_active:number}>();
  if (user?.is_active !== 1 || String(user.role).toLowerCase() !== 'admin')
    return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const status = String(c.req.query('status') || 'review_required');
  if (!['pending_analysis','analyzing','review_required','approved','rejected','cancelled'].includes(status))
    return c.json({ok:false,error:'INVALID_STATUS'},400);
  try {
    const rows = await c.env.DB.prepare(
      'SELECT id,user_id,source_sha256,registration_mode,status,reasons_json,classifier_version,created_at,updated_at,decided_at FROM v5_music_gate_reviews WHERE status=? ORDER BY created_at ASC LIMIT 100'
    ).bind(status).all();
    return c.json({ok:true,reviews:rows.results || []});
  } catch {
    return c.json({ok:false,error:'MUSIC_GATE_SCHEMA_NOT_READY'},503);
  }
});


router.post('/reviews/:id/decision', async (c) => {
  const token=(c.req.header('Authorization')||'').replace(/^Bearer /i,'').trim();
  const payload=token?await verifyToken(token,c.env.JWT_SECRET).catch(()=>null):null;
  const actor=Number(payload?.sub||0);
  if(!Number.isSafeInteger(actor)||actor<=0)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const admin=await c.env.DB.prepare('SELECT role,is_active FROM users WHERE id=?').bind(actor).first<{role:string;is_active:number}>();
  if(admin?.is_active!==1||String(admin.role).toLowerCase()!=='admin')
    return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const id=String(c.req.param('id')||'');
  if(!/^[a-f0-9-]{36}$/i.test(id))return c.json({ok:false,error:'INVALID_REVIEW_ID'},400);
  const body=await c.req.json().catch(()=>null) as {action?:string;note?:string;source_sha256?:string}|null;
  if(body?.action!=='approve'&&body?.action!=='reject')
    return c.json({ok:false,error:'INVALID_ACTION'},400);
  const note=String(body.note||'').trim();
  const hash=String(body.source_sha256||'').toLowerCase();
  if(note.length<10||note.length>2000)return c.json({ok:false,error:'REVIEW_REASON_REQUIRED'},400);
  if(!/^[a-f0-9]{64}$/.test(hash))return c.json({ok:false,error:'SOURCE_HASH_REQUIRED'},400);
  try {
    const record=await c.env.DB.prepare(
      'SELECT status,source_sha256,classifier_version,evidence_json FROM v5_music_gate_reviews WHERE id=?'
    ).bind(id).first<{status:string;source_sha256:string;classifier_version:string|null;evidence_json:string|null}>();
    if(!record)return c.json({ok:false,error:'REVIEW_NOT_FOUND'},404);
    if(record.status!=='review_required')return c.json({ok:false,error:'REVIEW_NOT_READY'},409);
    if(record.source_sha256!==hash)return c.json({ok:false,error:'SOURCE_HASH_MISMATCH'},409);
    if(!record.classifier_version||!record.evidence_json)
      return c.json({ok:false,error:'AI_EVIDENCE_REQUIRED'},409);
    let evidence:unknown;
    try { evidence=JSON.parse(record.evidence_json); } catch { return c.json({ok:false,error:'INVALID_AI_EVIDENCE'},409); }
    if(!evidence||typeof evidence!=='object'||Array.isArray(evidence)||Object.keys(evidence).length===0)
      return c.json({ok:false,error:'EMPTY_AI_EVIDENCE'},409);
    const status=body.action==='approve'?'approved':'rejected';
    const result=await c.env.DB.prepare(
      "UPDATE v5_music_gate_reviews SET status=?,reviewer_user_id=?,reviewer_note=?,decided_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='review_required' AND source_sha256=? AND classifier_version IS NOT NULL AND evidence_json IS NOT NULL"
    ).bind(status,actor,note,id,hash).run();
    if(Number(result.meta?.changes||0)!==1)return c.json({ok:false,error:'REVIEW_CONFLICT'},409);
    return c.json({ok:true,id,status,reviewer_user_id:actor,
      rights_verification_required:true,publication_approved:false,rewards_approved:false});
  } catch(e) {
    console.error('[V5_MUSIC_GATE_DECISION]',e);
    return c.json({ok:false,error:'MUSIC_GATE_REVIEW_UNAVAILABLE'},503);
  }
});


/** Administrator imports trusted analysis results; no user-supplied classification is accepted. */
router.post('/reviews/:id/analysis',async c=>{
  const token=(c.req.header('Authorization')||'').replace(/^Bearer /i,'').trim();
  const payload=token?await verifyToken(token,c.env.JWT_SECRET).catch(()=>null):null;
  const actor=Number(payload?.sub||0);
  if(!Number.isSafeInteger(actor)||actor<=0)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const admin=await c.env.DB.prepare('SELECT role,is_active FROM users WHERE id=?').bind(actor).first<{role:string;is_active:number}>();
  if(admin?.is_active!==1||String(admin.role).toLowerCase()!=='admin')
    return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
  const id=String(c.req.param('id')||'');
  if(!/^[a-f0-9-]{36}$/i.test(id))return c.json({ok:false,error:'INVALID_REVIEW_ID'},400);
  const body=await c.req.json().catch(()=>null) as {
    source_sha256?:string;classifier_version?:string;
    decoded?:boolean;music_probability?:number;speech_probability?:number;
    unsafe_content?:string;fingerprint_matches?:number;catalog_match?:string;
  }|null;
  const hash=String(body?.source_sha256||'').toLowerCase();
  const version=String(body?.classifier_version||'').trim();
  const prob=(n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1;
  if(!/^[a-f0-9]{64}$/.test(hash)||!/^[-.a-zA-Z0-9_]{3,100}$/.test(version)||
    typeof body?.decoded!=='boolean'||!prob(body?.music_probability)||!prob(body?.speech_probability)||
    !['clear','suspected','unknown'].includes(String(body?.unsafe_content))||
    !Number.isSafeInteger(body?.fingerprint_matches)||Number(body?.fingerprint_matches)<0||
    !['matched','not_found','unavailable','not_required'].includes(String(body?.catalog_match)))
    return c.json({ok:false,error:'INVALID_ANALYSIS_EVIDENCE'},400);
  try{
    const record=await c.env.DB.prepare(
      'SELECT status,source_sha256 FROM v5_music_gate_reviews WHERE id=?'
    ).bind(id).first<{status:string;source_sha256:string}>();
    if(!record)return c.json({ok:false,error:'REVIEW_NOT_FOUND'},404);
    if(record.source_sha256!==hash)return c.json({ok:false,error:'SOURCE_HASH_MISMATCH'},409);
    if(!['pending_analysis','analyzing'].includes(record.status))
      return c.json({ok:false,error:'ANALYSIS_ALREADY_FINALIZED'},409);
    const evidence=JSON.stringify({
      decoded:body!.decoded,music_probability:body!.music_probability,
      speech_probability:body!.speech_probability,unsafe_content:body!.unsafe_content,
      fingerprint_matches:body!.fingerprint_matches,catalog_match:body!.catalog_match,
      submitted_by_admin_user_id:actor
    });
    // Only administrator-submitted, complete and unambiguous results can take the
    // initial automated clearance path. This is NOT live AI inference.
    const outcome=decideInitialGate({
      analysisComplete:body!.unsafe_content!=='unknown' && body!.catalog_match!=='unavailable',
      audioDecoded:body!.decoded===true,
      validMusicOrSpokenAudio:Number(body!.music_probability)>=0.98 ||
        Number(body!.speech_probability)>=0.98,
      socialRiskSignals:body!.unsafe_content==='clear'?[]:['uncertain_context'],
      rightsClaimConflict:Number(body!.fingerprint_matches)>0 || body!.catalog_match==='matched'
    });
    // Manual evidence entry is not a trusted AI service result. Do not auto-approve
    // until an authenticated analysis worker and independent evidence validation exist.
    const autoClear=false;
    const suggestedOutcome=outcome;
    const nextStatus=autoClear?'approved':'review_required';
    const result=await c.env.DB.prepare(
      "UPDATE v5_music_gate_reviews SET status=?,classifier_version=?,evidence_json=?,reviewer_user_id=?,reviewer_note=?,decided_at=CASE WHEN ?='approved' THEN datetime('now') ELSE NULL END,updated_at=datetime('now') WHERE id=? AND source_sha256=? AND status IN ('pending_analysis','analyzing')"
    ).bind(nextStatus,version,evidence,autoClear?actor:null,
      autoClear?'Automated technical clearance from administrator-submitted analysis; rights not verified':null,
      nextStatus,id,hash).run();
    if(Number(result.meta?.changes||0)!==1)return c.json({ok:false,error:'ANALYSIS_CONFLICT'},409);
    return c.json({ok:true,id,status:nextStatus,auto_technical_clearance:autoClear,rights_verified:false,rewards_approved:false,suggested_outcome:suggestedOutcome,message:'Analysis evidence stored for review; no AI inference or automatic approval was performed.'});
  }catch(e){
    console.error('[V5_MUSIC_GATE_ANALYSIS]',e);
    return c.json({ok:false,error:'MUSIC_GATE_ANALYSIS_UNAVAILABLE'},503);
  }
});


/** Service-to-service analysis queue. Requires a separate Worker secret.
 * Never returns original audio or authorizes a publication.
 */
router.get('/automation/pending', async c=>{
  const expected=String((c.env as Env & {MUSIC_GATE_WORKER_SECRET?:string}).MUSIC_GATE_WORKER_SECRET||'');
  const supplied=String(c.req.header('X-Music-Gate-Worker-Secret')||'');
  if(expected.length<32||supplied.length!==expected.length)
    return c.json({ok:false,error:'SERVICE_UNAVAILABLE'},503);
  const a=new TextEncoder().encode(expected),b=new TextEncoder().encode(supplied);
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
  if(diff!==0)return c.json({ok:false,error:'SERVICE_FORBIDDEN'},403);
  try {
    const rows=await c.env.DB.prepare(
      "SELECT id,user_id,source_key,source_sha256,registration_mode,created_at FROM v5_music_gate_reviews WHERE status='pending_analysis' ORDER BY created_at ASC LIMIT 20"
    ).all();
    return c.json({ok:true,jobs:rows.results||[]});
  }catch {
    return c.json({ok:false,error:'MUSIC_GATE_SCHEMA_NOT_READY'},503);
  }
});

export default router;
