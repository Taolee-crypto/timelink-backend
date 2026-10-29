import {Hono} from 'hono';
import type {Context} from 'hono';
import type {Env} from '../types';
import {verifyToken} from '../auth';
import {
 previewPurchasedTlMaturity,reviewPurchasedTlMaturity,settleReviewedPurchasedTlMaturity
} from '../v5-purchased-tl-conversion';

const router=new Hono<{Bindings:Env}>();
async function adminActor(c:Context<{Bindings:Env}>):Promise<number|null>{
 const token=String(c.req.header('Authorization')||'').replace(/^Bearer\s+/i,'').trim();
 if(!token)return null;
 const payload=await verifyToken(token,c.env.JWT_SECRET).catch(()=>null);
 const id=Number(payload?.sub||0);
 if(!Number.isSafeInteger(id)||id<=0)return null;
 const user=await c.env.DB.prepare('SELECT role,is_active FROM users WHERE id=?').bind(id)
  .first<{role:string;is_active:number}>();
 return user?.is_active===1&&String(user.role||'').toLowerCase()==='admin'?id:null;
}
function errorCode(e:unknown){
 const message=e instanceof Error?e.message:'PURCHASE_MATURITY_UNAVAILABLE';
 if(/^[A-Z_]+(?::[A-Z_]+)?$/.test(message))return message;
 return 'PURCHASE_MATURITY_UNAVAILABLE';
}
router.get('/preview/:userId/:paymentKey',async c=>{
 if(!await adminActor(c))return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
 try{
  return c.json({ok:true,...await previewPurchasedTlMaturity(c.env.DB,
    c.req.param('userId'),c.req.param('paymentKey'))});
 }catch(e){const code=errorCode(e);return c.json({ok:false,error:code},409);}
});
router.post('/review/:userId/:paymentKey',async c=>{
 const actor=await adminActor(c);
 if(!actor)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
 const body=await c.req.json().catch(()=>null) as any;
 if(!body||body.confirmation!=='I_VERIFIED_ALL_REFUND_RIGHTS')
  return c.json({ok:false,error:'EXPLICIT_LEGAL_REVIEW_REQUIRED'},400);
 try{
  const result=await reviewPurchasedTlMaturity(c.env.DB,{
   userId:c.req.param('userId'),paymentKey:c.req.param('paymentKey'),
   reviewerId:actor,refundDeadlineMs:Number(body.refund_deadline_ms),
   country:String(body.country||'').toUpperCase(),legalBasis:String(body.legal_basis||''),
   evidenceSha256:String(body.evidence_sha256||'').toLowerCase(),
   reviewNote:String(body.review_note||'')
  });
  return c.json({ok:true,...result});
 }catch(e){const code=errorCode(e);return c.json({ok:false,error:code},409);}
});
router.post('/convert/:userId/:paymentKey',async c=>{
 const actor=await adminActor(c);
 if(!actor)return c.json({ok:false,error:'ADMIN_REQUIRED'},403);
 // No code path writes conversion assets unless explicitly switched on.
 if(c.env.V5_TLP_MATURITY_WRITE_ENABLED!=='true')
  return c.json({ok:false,error:'PURCHASE_MATURITY_DISABLED'},403);
 const body=await c.req.json().catch(()=>null) as any;
 if(!body||body.confirmation!=='CONVERT_REVIEWED_TL_P_TO_TL_B')
  return c.json({ok:false,error:'EXPLICIT_CONVERSION_CONFIRMATION_REQUIRED'},400);
 try{
  const result=await settleReviewedPurchasedTlMaturity(c.env.DB,{
   userId:c.req.param('userId'),paymentKey:c.req.param('paymentKey'),
   adminId:actor,expectedRemainingAtoms:Number(body.expected_remaining_atoms)
  });
  return c.json({ok:true,...result});
 }catch(e){
  console.error('[V5_PURCHASED_TL_MATURITY_CONVERSION]',e);
  const code=errorCode(e);
  return c.json({ok:false,error:code},409);
 }
});
export default router;
