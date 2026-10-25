import {Hono} from 'hono';
import type {Env} from '../types';
import {verifyToken} from '../auth';
import {readCreatorPayoutReport} from '../creator-payout-report';
const router=new Hono<{Bindings:Env}>();
router.get('/earnings',async c=>{
 const token=(c.req.header('Authorization')||'').replace(/^Bearer\s+/i,'').trim();
 const identity=token?await verifyToken(token,c.env.JWT_SECRET).catch(()=>null):null;
 const userId=Number(identity?.sub||0);
 if(!Number.isSafeInteger(userId)||userId<=0)return c.json({ok:false,error:'로그인이 필요합니다.'},401);
 const user=await c.env.DB.prepare('SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0').bind(userId).first();
 if(!user)return c.json({ok:false,error:'유효한 회원 계정이 필요합니다.'},401);
 try{
  const report=await readCreatorPayoutReport(c.env.DB,userId);
  return c.json({...report,account_id:userId});
 }catch(error){console.error('[CREATOR_EARNINGS]',error);return c.json({ok:false,error:'내 음악 수익을 조회하지 못했습니다.'},503);}
});
export default router;
