import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';
import {ensureReferralRewardSchema,settleVerifiedReferral,type ReferralMilestone} from '../v5-referral-reward';
import {readRewardPolicy} from '../v5-reward-policy';

const router = new Hono<{ Bindings: Env }>();
async function member(c:any) {
  // Require a real HTTP Bearer separator, not the literal two-character "\s".
  // A signed token still belongs to an active, non-forfeited account.
  const header=String(c.req.header('Authorization')||'');
  const match=/^Bearer\s+(\S+)$/i.exec(header.trim());
  if(!match)return null;
  const claims=await verifyToken(match[1],String(c.env.JWT_SECRET||'')).catch(()=>null);
  const id=Number(claims?.sub||0);
  if(!Number.isSafeInteger(id)||id<=0)return null;
  const active=await c.env.DB.prepare(
    'SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0'
  ).bind(id).first().catch(()=>null);
  return active?id:null;
}
async function tables(db:any){
  await db.prepare("CREATE TABLE IF NOT EXISTS v5_member_referral_codes (user_id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS v5_member_referral_claims (referred_user_id INTEGER PRIMARY KEY, referrer_user_id INTEGER NOT NULL, code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending_verification', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK (referrer_user_id != referred_user_id))").run();
}
router.get('/me',async c=>{
  const id=await member(c);if(!id)return c.json({ok:false,code:'AUTH_REQUIRED'},401);
  try{
    await tables(c.env.DB);
    const own=await c.env.DB.prepare('SELECT code FROM v5_member_referral_codes WHERE user_id=?').bind(id).first<any>();
    const rows=await c.env.DB.prepare('SELECT status, COUNT(*) AS total FROM v5_member_referral_claims WHERE referrer_user_id=? GROUP BY status').bind(id).all<any>();
    await ensureReferralRewardSchema(c.env.DB);
    const payments=await c.env.DB.prepare("SELECT milestone,referred_user_id,source_reference,credited_tl_b,poc_points,status,created_at FROM v5_referral_reward_receipts WHERE referrer_user_id=? ORDER BY created_at DESC LIMIT 100").bind(id).all<any>();
    const policy=await readRewardPolicy(c.env.DB);
    return c.json({ok:true,code:own?.code||null,summary:rows.results||[],
      rewards:payments.results||[],rewards_enabled:true,
      reward_policy_version:policy.version,
      available_reward_types:['signup_verified','store_first_paid'],
      note:'TL_B 지급량과 POC 가중치는 관리자가 수동 조정합니다. 지급량 0은 기여 인정만 의미합니다.'});
  }catch(e){console.error('referral me',e);return c.json({ok:false,code:'REFERRAL_UNAVAILABLE'},503);}
});
router.post('/code',async c=>{
  const id=await member(c);if(!id)return c.json({ok:false,code:'AUTH_REQUIRED'},401);
  try{
    await tables(c.env.DB);
    const current=await c.env.DB.prepare('SELECT code FROM v5_member_referral_codes WHERE user_id=?').bind(id).first<any>();
    if(current?.code)return c.json({ok:true,code:current.code});
    const code='TILO-'+Array.from(crypto.getRandomValues(new Uint8Array(12)),b=>b.toString(16).padStart(2,'0')).join('').toUpperCase();
    await c.env.DB.prepare('INSERT OR IGNORE INTO v5_member_referral_codes(user_id,code) VALUES (?,?)').bind(id,code).run();
    const stored=await c.env.DB.prepare('SELECT code FROM v5_member_referral_codes WHERE user_id=?').bind(id).first<any>();
    return c.json({ok:true,code:stored?.code});
  }catch(e){console.error('referral code',e);return c.json({ok:false,code:'REFERRAL_UNAVAILABLE'},503);}
});
router.post('/claim',async c=>{
  const id=await member(c);if(!id)return c.json({ok:false,code:'AUTH_REQUIRED'},401);
  let body:any;try{body=await c.req.json();}catch{return c.json({ok:false,code:'INVALID_BODY'},400);}
  const code=String(body?.code||'').trim().toUpperCase();
  if(!/^TILO-[A-F0-9]{24}$/.test(code))return c.json({ok:false,code:'INVALID_CODE'},400);
  try{
    await tables(c.env.DB);
    const ref=await c.env.DB.prepare(
      'SELECT codes.user_id FROM v5_member_referral_codes codes JOIN users u ON u.id=codes.user_id WHERE codes.code=? AND COALESCE(u.is_active,1)=1 AND COALESCE(u.account_forfeited,0)=0'
    ).bind(code).first<any>();
    if(!ref)return c.json({ok:false,code:'CODE_NOT_FOUND'},404);
    if(Number(ref.user_id)===id)return c.json({ok:false,code:'SELF_REFERRAL'},409);
    const inserted=await c.env.DB.prepare("INSERT OR IGNORE INTO v5_member_referral_claims(referred_user_id,referrer_user_id,code) VALUES (?,?,?)").bind(id,ref.user_id,code).run();
    if(!inserted.meta?.changes)return c.json({ok:false,code:'ALREADY_CLAIMED'},409);
    // The newly registered user can claim immediately after verified signup.
    // Failure to settle never converts an unverified claim into a payout.
    let rewardStatus:'pending_verification'|'verified_signup'='pending_verification';
    let creditedTlB=0;
    try{
      const reward=await settleVerifiedReferral(c.env.DB,Number(ref.user_id),id,'signup_verified');
      if(reward.status==='posted'){rewardStatus='verified_signup';creditedTlB=Number(reward.tl_b||0);}
    }catch(error){console.warn('[REFERRAL_AWAIT_VERIFICATION]',String(error));}
    return c.json({ok:true,status:rewardStatus,contribution_verified:rewardStatus==='verified_signup',reward_issued:creditedTlB>0,credited_tl_b:creditedTlB});
  }catch(e){console.error('referral claim',e);return c.json({ok:false,code:'REFERRAL_UNAVAILABLE'},503);}
});
/**
 * User-triggered verification is safe because both milestones are independently
 * derived from verified membership and provider-confirmed store order records.
 * Caller cannot supply TL amounts, POC units, proof IDs or arbitrary recipients.
 */
router.post('/settle',async c=>{
  const id=await member(c);if(!id)return c.json({ok:false,code:'AUTH_REQUIRED'},401);
  const body=await c.req.json().catch(()=>null) as any;
  const referredId=Number(body?.referred_user_id);
  const milestone=String(body?.milestone||'') as ReferralMilestone;
  if(!Number.isSafeInteger(referredId)||referredId<=0||
     !['signup_verified','store_first_paid'].includes(milestone)||
     !body||typeof body!=='object'||Array.isArray(body)||
     Object.keys(body).some(key=>!['referred_user_id','milestone'].includes(key)))
    return c.json({ok:false,code:'INVALID_REFERRAL_SETTLEMENT'},400);
  try{
    await tables(c.env.DB);
    const earned=await settleVerifiedReferral(c.env.DB,id,referredId,milestone);
    return c.json({ok:true,...earned});
  }catch(error:any){
    const code=String(error.message||error);
    if(['SELF_REFERRAL','REFERRAL_VERIFICATION_REQUIRED','REFERRAL_SIGNUP_WINDOW_EXPIRED',
       'VERIFIED_STORE_PAYMENT_REQUIRED'].includes(code))
      return c.json({ok:false,code},409);
    console.error('[V5_REFERRAL_SETTLEMENT]',code);
    return c.json({ok:false,code:'REFERRAL_SETTLEMENT_UNAVAILABLE'},503);
  }
});
export default router;
