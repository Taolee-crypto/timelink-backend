import {Hono} from 'hono';
import type {Env} from '../types';
import {verifyToken} from '../auth';
import {ensureCreatorSplitSchema,normalizePhone,hashPhone,percentageToBps,readCreatorSplit} from '../creator-split-policy';
const router=new Hono<{Bindings:Env;Variables:{userId:number}}>();
router.use('*',async(c,next)=>{
 const p=await verifyToken((c.req.header('Authorization')||'').replace(/^Bearer\s+/i,''),c.env.JWT_SECRET).catch(()=>null);
 const id=Number(p?.sub);if(!Number.isSafeInteger(id)||id<=0)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 const u=await c.env.DB.prepare('SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0').bind(id).first();
 if(!u)return c.json({ok:false,error:'AUTH_REQUIRED'},401);c.set('userId',id);await ensureCreatorSplitSchema(c.env.DB);await next();
});
const configured=(e:Env)=>!!(e.TWILIO_ACCOUNT_SID&&e.TWILIO_AUTH_TOKEN&&e.TWILIO_VERIFY_SERVICE_SID);
async function provider(e:Env,resource:string,data:Record<string,string>){
 if(!configured(e))throw new Error('PHONE_VERIFICATION_NOT_CONFIGURED');
 const r=await fetch('https://verify.twilio.com/v2/Services/'+e.TWILIO_VERIFY_SERVICE_SID+'/'+resource,{method:'POST',headers:{Authorization:'Basic '+btoa(e.TWILIO_ACCOUNT_SID+':'+e.TWILIO_AUTH_TOKEN),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(data),signal:AbortSignal.timeout(12000),redirect:'manual'});
 if(!r.ok){await r.body?.cancel();throw new Error('PHONE_PROVIDER_UNAVAILABLE');}return r.json() as Promise<any>;
}
router.get('/phone/status',async c=>{
 const row=await c.env.DB.prepare('SELECT phone_last4,verified_at FROM v5_creator_verified_phones WHERE user_id=?').bind(c.get('userId')).first();
 return c.json({ok:true,available:configured(c.env),identity:row||null,verification_type:'phone_possession'});
});
router.post('/phone/send',async c=>{
 if(!configured(c.env))return c.json({ok:false,error:'PHONE_VERIFICATION_NOT_CONFIGURED'},503);
 try{
 const b=await c.req.json<any>(),phone=normalizePhone(b.phone);if(b.consent!==true)return c.json({ok:false,error:'PHONE_VERIFICATION_CONSENT_REQUIRED'},400);
 const hash=await hashPhone(phone,c.env.JWT_SECRET),id=crypto.randomUUID(),uid=c.get('userId'),now=Math.floor(Date.now()/1000);
 const lock=await c.env.DB.prepare(`INSERT INTO v5_creator_phone_challenges(id,user_id,phone_hash,phone_last4,created_at)
  SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM v5_creator_phone_challenges WHERE user_id=? AND created_at>?)
  AND (SELECT COUNT(*) FROM v5_creator_phone_challenges WHERE user_id=? AND created_at>?)<5
  AND (SELECT COUNT(*) FROM v5_creator_phone_challenges WHERE phone_hash=? AND created_at>?)<5`)
  .bind(id,uid,hash,phone.slice(-4),now,uid,now-60,uid,now-3600,hash,now-3600).run();
 if(Number(lock.meta?.changes)!==1)return c.json({ok:false,error:'PHONE_SEND_RATE_LIMIT'},429);
 const result=await provider(c.env,'Verifications',{To:phone,Channel:'sms'});
 if(result.status!=='pending'||result.service_sid!==c.env.TWILIO_VERIFY_SERVICE_SID||result.to!==phone)throw new Error('PHONE_PROVIDER_UNAVAILABLE');
 return c.json({ok:true,challenge_id:id,expires_in:600});
 }catch(e){return c.json({ok:false,error:e instanceof Error?e.message:'PHONE_PROVIDER_UNAVAILABLE'},e instanceof Error&&e.message==='PHONE_E164_REQUIRED'?400:503);}
});
router.post('/phone/check',async c=>{
 if(!configured(c.env))return c.json({ok:false,error:'PHONE_VERIFICATION_NOT_CONFIGURED'},503);
 try{
 const b=await c.req.json<any>(),phone=normalizePhone(b.phone),uid=c.get('userId'),hash=await hashPhone(phone,c.env.JWT_SECRET);
 if(!/^\d{4,10}$/.test(String(b.code||'')))return c.json({ok:false,error:'INVALID_VERIFICATION_CODE'},400);
 const challenge=await c.env.DB.prepare(`UPDATE v5_creator_phone_challenges SET attempts=attempts+1 WHERE id=? AND user_id=? AND phone_hash=? AND status='pending' AND attempts<5 AND created_at>unixepoch()-600 RETURNING id`)
  .bind(String(b.challenge_id||''),uid,hash).first();
 if(!challenge)return c.json({ok:false,error:'PHONE_CHALLENGE_EXPIRED_OR_LOCKED'},409);
 const result=await provider(c.env,'VerificationCheck',{To:phone,Code:String(b.code)});
 if(result.status!=='approved'||result.valid!==true||result.to!==phone||result.service_sid!==c.env.TWILIO_VERIFY_SERVICE_SID||result.account_sid!==c.env.TWILIO_ACCOUNT_SID)return c.json({ok:false,error:'PHONE_CODE_NOT_APPROVED'},400);
 await c.env.DB.batch([
 c.env.DB.prepare(`INSERT INTO v5_creator_verified_phones(user_id,phone_hash,phone_last4) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET phone_hash=excluded.phone_hash,phone_last4=excluded.phone_last4,verified_at=datetime('now')`).bind(uid,hash,phone.slice(-4)),
 c.env.DB.prepare("UPDATE v5_creator_phone_challenges SET status='verified' WHERE id=? AND user_id=?").bind(b.challenge_id,uid)]);
 return c.json({ok:true,phone_last4:phone.slice(-4),verification_type:'phone_possession'});
 }catch(e){if(/UNIQUE constraint.*phone_hash/.test(String(e)))return c.json({ok:false,error:'PHONE_ALREADY_LINKED'},409);return c.json({ok:false,error:'PHONE_VERIFICATION_UNAVAILABLE'},503);}
});
router.get('/claims',async c=>{
 const rows=await c.env.DB.prepare(`SELECT m.id,m.file_id,m.version,m.role,m.name,m.share_bps,m.consent,f.title
 FROM v5_creator_split_members m JOIN v5_creator_split_heads h ON h.file_id=m.file_id AND h.version=m.version
 JOIN v5_creator_verified_phones p ON p.phone_hash=m.phone_hash LEFT JOIN tl_files f ON f.id=m.file_id
 WHERE p.user_id=? ORDER BY m.file_id DESC LIMIT 100`).bind(c.get('userId')).all();
 return c.json({ok:true,claims:rows.results||[]});
});
router.post('/claims/:id/consent',async c=>{
 const b=await c.req.json<any>().catch(()=>null);if(!['accept','reject'].includes(b?.action)||!Number.isSafeInteger(b?.version))return c.json({ok:false,error:'INVALID_CONSENT'},400);
 const r=await c.env.DB.prepare(`UPDATE v5_creator_split_members SET consent=?,recipient_user_id=?,consented_at=datetime('now')
 WHERE id=? AND version=? AND consent='pending' AND version=(SELECT version FROM v5_creator_split_heads h WHERE h.file_id=v5_creator_split_members.file_id)
 AND phone_hash=(SELECT phone_hash FROM v5_creator_verified_phones WHERE user_id=?) RETURNING file_id`)
 .bind(b.action==='accept'?'accepted':'rejected',c.get('userId'),c.req.param('id'),b.version,c.get('userId')).first<{file_id:number}>();
 if(!r)return c.json({ok:false,error:'CLAIM_NOT_FOUND_OR_CHANGED'},409);
 const split=await readCreatorSplit(c.env.DB,r.file_id);
 return c.json({ok:true,split:split?{version:split.version,basis:split.basis,total_bps:split.total_bps,ready:split.ready}:null});
});
router.get('/tracks/:id',async c=>{
 const id=Number(c.req.param('id'));const file=await c.env.DB.prepare('SELECT user_id FROM tl_files WHERE id=?').bind(id).first<{user_id:number}>();
 if(Number(file?.user_id)!==c.get('userId'))return c.json({ok:false,error:'NOT_FOUND'},404);
 return c.json({ok:true,split:await readCreatorSplit(c.env.DB,id)});
});
router.post('/tracks/:id',async c=>{
 try{
 const id=Number(c.req.param('id')),uid=c.get('userId'),b=await c.req.json<any>();
 const f=await c.env.DB.prepare('SELECT user_id FROM tl_files WHERE id=?').bind(id).first<{user_id:number}>();if(Number(f?.user_id)!==uid)return c.json({ok:false,error:'NOT_FOUND'},404);
 if(!Array.isArray(b.members)||b.members.length<1||b.members.length>50||!Number.isSafeInteger(b.expected_version)||b.expected_version<0)return c.json({ok:false,error:'INVALID_SPLIT'},400);
 const rows=[];let total=0;const seen=new Set<string>();
 for(const m of b.members){
 if(!['lyrics','composition','arrangement','master'].includes(m.role)||typeof m.name!=='string'||!m.name.trim()||m.name.length>200)throw new Error('INVALID_CONTRIBUTOR');
 const share=percentageToBps(m.share_percent);total+=share;
 const phone=m.phone?normalizePhone(m.phone):null;
 const previous=!phone&&typeof m.member_id==='string'?await c.env.DB.prepare('SELECT phone_hash,phone_last4 FROM v5_creator_split_members WHERE id=? AND file_id=? AND version=?').bind(m.member_id,id,b.expected_version).first<{phone_hash:string|null;phone_last4:string|null}>():null;
 const hash=phone?await hashPhone(phone,c.env.JWT_SECRET):previous?.phone_hash||null;
 if(hash){const k=m.role+':'+hash;if(seen.has(k))throw new Error('DUPLICATE_CONTRIBUTOR_ROLE');seen.add(k);}
 rows.push({id:crypto.randomUUID(),role:m.role,name:m.name.trim(),share,hash,last4:phone?.slice(-4)||previous?.phone_last4||null});
 }
 if(total>10000)throw new Error('TOTAL_SHARE_EXCEEDS_100');
 const current=await c.env.DB.prepare('SELECT version FROM v5_creator_split_heads WHERE file_id=?').bind(id).first<{version:number}>();
 if(Number(current?.version||0)!==b.expected_version)return c.json({ok:false,error:'SPLIT_VERSION_CONFLICT'},409);
 const version=b.expected_version+1;
 await c.env.DB.batch([
 c.env.DB.prepare('INSERT INTO v5_creator_split_versions(file_id,version,owner_user_id,total_bps) VALUES(?,?,?,?)').bind(id,version,uid,total),
 ...rows.map(r=>c.env.DB.prepare('INSERT INTO v5_creator_split_members(id,file_id,version,role,name,share_bps,phone_hash,phone_last4) VALUES(?,?,?,?,?,?,?,?)').bind(r.id,id,version,r.role,r.name,r.share,r.hash,r.last4)),
 c.env.DB.prepare('INSERT INTO v5_creator_split_heads(file_id,version) VALUES(?,?) ON CONFLICT(file_id) DO UPDATE SET version=excluded.version WHERE v5_creator_split_heads.version=?').bind(id,version,b.expected_version)]);
 return c.json({ok:true,split:await readCreatorSplit(c.env.DB,id)});
 }catch(e){if(/UNIQUE constraint/.test(String(e)))return c.json({ok:false,error:'SPLIT_VERSION_CONFLICT'},409);return c.json({ok:false,error:e instanceof Error?e.message:'SPLIT_SAVE_FAILED'},400);}
});
export default router;
