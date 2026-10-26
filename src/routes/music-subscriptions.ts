import {Hono} from 'hono';
import type {Context} from 'hono';
import type {Env} from '../types';
import {verifyToken} from '../auth';
import {dailyFreeCatalogue} from '../v5-daily-free-policy';
import {readDailyMusicAllowance} from '../v5-subscription-meter';
import {prepareMusicOrder,confirmMusicOrder,MusicOrderError,type MusicCheckoutConfig,type MusicCheckoutMode} from '../v5-music-subscription-orders';
const router=new Hono<{Bindings:Env}>();
function config(env:Env):MusicCheckoutConfig{return {mode:(env.MUSIC_SUBSCRIPTION_CHECKOUT_MODE||'disabled') as MusicCheckoutMode,secret:env.TOSS_SECRET_KEY||'',timezone:env.MUSIC_SUBSCRIPTION_BILLING_TIMEZONE||'Asia/Seoul'};}
async function user(c:Context<{Bindings:Env}>){
 const token=(c.req.header('Authorization')||'').replace(/^Bearer\s+/i,'').trim();if(!token)return null;
 const payload=await verifyToken(token,c.env.JWT_SECRET).catch(()=>null),id=Number(payload?.sub||0);
 if(!Number.isSafeInteger(id)||id<1)return null;
 return await c.env.DB.prepare('SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0').bind(id).first<{id:number}>();
}
router.get('/products',c=>{
 const cfg=config(c.env),key=c.env.TOSS_CLIENT_KEY||'';
 const testReady=cfg.mode==='test'&&cfg.secret.startsWith('test_sk_')&&key.startsWith('test_ck_');
 return c.json({ok:true,products:dailyFreeCatalogue(),checkoutMode:cfg.mode,checkoutEnabled:false,
  orderApiEnabled:cfg.mode!=='disabled',testCheckoutEnabled:testReady,clientKey:testReady?key:null,
  billingTimezone:cfg.timezone,billingPeriod:'calendar_month_utc',autoRenew:false,
  note:'정식 판매 준비 중입니다. 운영자가 구성한 시험결제만 별도로 확인할 수 있습니다.'});
});
router.get('/status',async c=>{const u=await user(c);if(!u)return c.json({ok:false,error:'AUTH_REQUIRED'},401);return c.json({ok:true,userId:u.id,...await readDailyMusicAllowance(c.env.DB,u.id)});});
router.post('/prepare',async c=>{
 const u=await user(c);if(!u)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 try{const b=await c.req.json<{level:number;requestKey:string;termsAccepted:boolean}>().catch(()=>null);if(!b)return c.json({ok:false,error:'INVALID_REQUEST'},400);if(b.termsAccepted!==true)return c.json({ok:false,error:'TERMS_REQUIRED'},400);
 return c.json({ok:true,...await prepareMusicOrder(c.env.DB,u.id,b.level,b.requestKey,config(c.env))});
 }catch(error){if(error instanceof MusicOrderError)return c.json({ok:false,error:error.code},error.httpStatus);console.error('[MUSIC_ORDER_PREPARE]',error);return c.json({ok:false,error:'MUSIC_ORDER_PREPARATION_FAILED'},503);}
});
router.post('/confirm',async c=>{
 const u=await user(c);if(!u)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 try{const b=await c.req.json<{orderId:string;paymentKey:string;amount:number}>().catch(()=>null);if(!b)return c.json({ok:false,error:'INVALID_REQUEST'},400);return c.json(await confirmMusicOrder(c.env.DB,u.id,b.orderId,b.paymentKey,b.amount,config(c.env)));
 }catch(error){if(error instanceof MusicOrderError)return c.json({ok:false,error:error.code},error.httpStatus);console.error('[MUSIC_ORDER_CONFIRM]',error);return c.json({ok:false,error:'MUSIC_ORDER_CONFIRMATION_FAILED'},503);}
});
export default router;
