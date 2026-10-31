/** TL -> TLC escrow: authenticated read endpoints only until funding and payout are atomic. */
import { Hono } from 'hono';
import { verifyToken } from './auth';
import { runEscrowSimulation } from './v5-exchange-simulator';
import type { Env } from './types';
const router=new Hono<{Bindings:Env}>();
async function owner(c:any){const raw=(c.req.header('Authorization')||'').replace(/^Bearer\s+/,'').trim();if(!raw)return null;const session=await verifyToken(raw,c.env.JWT_SECRET);const id=Number(session?.sub||0);return Number.isSafeInteger(id)&&id>0?id:null;}
router.post('/self-test',async c=>{const userId=await owner(c);if(!userId)return c.json({ok:false,error:'AUTH_REQUIRED'},401);const result=runEscrowSimulation();return c.json(result,result.ok?200:500);});
router.get('/status',async c=>{
 const userId=await owner(c);if(!userId)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 try{
  const policy=await c.env.DB.prepare('SELECT enabled,tlc_jetton_master,quote_tlc_atoms_per_tl,min_tl,max_tl,daily_tl_limit,liquidity_tlc_atoms FROM v5_exchange_policy WHERE policy_id=1').first<any>();
  return c.json({ok:true,trading_enabled:false,policy_configured:!!(policy?.enabled&&policy.tlc_jetton_master&&policy.quote_tlc_atoms_per_tl),reason:'ATOMIC_LEDGER_AND_TON_PAYOUT_NOT_VERIFIED',direction:'TL_TO_TLC_ONLY',tl_integer_only:true,tlc_decimals:9});
 }catch(_){return c.json({ok:true,trading_enabled:false,policy_configured:false,reason:'ESCROW_MIGRATION_NOT_APPLIED',direction:'TL_TO_TLC_ONLY',tl_integer_only:true,tlc_decimals:9});}
});
router.get('/orders',async c=>{
 const userId=await owner(c);if(!userId)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 try{const rows=await c.env.DB.prepare('SELECT order_id,tl_amount,tlc_atoms,status,created_at,updated_at FROM v5_exchange_orders WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 50').bind(userId).all();return c.json({ok:true,orders:rows.results||[]});}
 catch(_){return c.json({ok:false,error:'ESCROW_UNAVAILABLE'},503);}
});
router.post('/orders',async c=>{const userId=await owner(c);if(!userId)return c.json({ok:false,error:'AUTH_REQUIRED'},401);return c.json({ok:false,error:'TRADING_DISABLED_UNTIL_ATOMIC_RESERVATION_AND_VERIFIED_TON_SETTLEMENT'},503);});
export default router;
