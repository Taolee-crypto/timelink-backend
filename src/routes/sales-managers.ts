import {readSalesFinance,createSalesSettlement,transitionSalesSettlement} from '../sales-finance';
import {Hono} from 'hono';
import {ensureCafePublicProfiles} from '../cafe-public-profile';
import type {Env} from '../types';
import {verifyToken} from '../auth';
import {salesPolicy,salesTerms,signSalesContract,simulateSalesDeposit,reviewSalesMember,updateSalesPolicy,assignmentPlan,settleCafeService} from '../sales-managers';
import {tlToAtoms} from '../economy-ledger';
const router=new Hono<{Bindings:Env;Variables:{salesUser:{id:number;role:string}}}>();
router.use('*',async(c,next)=>{
 const path=new URL(c.req.url).pathname;
 if(c.req.method==='GET'&&(path.endsWith('/policy')||path.endsWith('/directory')||path.endsWith('/world')||/\/invites\/[a-zA-Z0-9]+$/.test(path)))return next();
 const token=(c.req.header('Authorization')||'').replace(/^Bearer\s+/,'');
 const payload=token?await verifyToken(token,c.env.JWT_SECRET).catch(()=>null):null;
 if(!payload)return c.json({ok:false,error:'로그인이 필요합니다.'},401);
 const user=await c.env.DB.prepare("SELECT id,role FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0").bind(Number(payload.sub)).first<any>();
 if(!user)return c.json({ok:false,error:'활성 계정이 필요합니다.'},401);c.set('salesUser',user);return next();
});
// The manager/DJ product was withdrawn. Keep historic read/settlement audit
// available, but do not sign new contracts, assign DJs or create new billing.
router.use('*',async(c,next)=>{
 if(c.req.method==='GET'||c.req.method==='HEAD'||c.req.method==='OPTIONS')return next();
 const p=new URL(c.req.url).pathname;
 if(/^\/api\/sales\/admin\/settlements(\/|$)/.test(p))return next();
 return c.json({ok:false,error:'RETIRED_SALES_MANAGER_DJ',message:'영업매니저·DJ 유료 서비스는 종료되었습니다.'},410);
});
router.get('/policy',async c=>{const p=await salesPolicy(c.env.DB);return c.json({ok:true,policy:p,terms:salesTerms(p)});});
router.get('/directory',async c=>{
 const managers=await c.env.DB.prepare("SELECT m.user_id,m.display_name,m.country FROM v5_sales_members m JOIN users u ON u.id=m.user_id WHERE m.state='active' AND COALESCE(u.is_active,1)=1 AND COALESCE(u.account_forfeited,0)=0 ORDER BY m.display_name LIMIT 500").all();
 const djs=await c.env.DB.prepare("SELECT d.id,d.dj_name FROM dj_profiles d JOIN users u ON u.id=d.user_id WHERE d.status='active' AND COALESCE(u.is_active,1)=1 AND COALESCE(u.account_forfeited,0)=0 ORDER BY d.dj_name LIMIT 500").all();
 return c.json({ok:true,managers:managers.results||[],djs:djs.results||[]});
});
router.get('/invites/:code',async c=>{
 const m=await c.env.DB.prepare("SELECT user_id,display_name,country FROM v5_sales_members WHERE invite_code=? AND state='active'").bind(c.req.param('code')).first();return m?c.json({ok:true,manager:m}):c.json({ok:false,error:'유효한 매니저 초대가 아닙니다.'},404);
});
router.get('/world',async c=>{
 const kind=c.req.query('kind')||'all';
 if(!['all','cafe','store'].includes(kind))return c.json({ok:false,error:'Invalid store category'},400);
 const page=Math.min(100000,Math.max(1,Number(c.req.query('page')||'1')|0));
 const limit=30,offset=(page-1)*limit;
 const country=String(c.req.query('country')||'').trim().toUpperCase();
 if(country&&!/^[A-Z]{2}$/.test(country))return c.json({ok:false,error:'Invalid country'},400);
 const search=String(c.req.query('q')||'').trim().slice(0,100);
 const term='%'+search.replace(/[\\%_]/g,'\\$&')+'%';
 try{
  await ensureCafePublicProfiles(c.env.DB);
  const where="c.status='active' AND (c.expires_at IS NULL OR c.expires_at>?) AND (?='all' OR COALESCE(s.kind,'cafe')=?) AND (?='' OR c.country=?) AND (?='' OR c.name LIKE ? ESCAPE '\\' OR c.addr LIKE ? ESCAPE '\\')";
  const from=' FROM cafe_channels c LEFT JOIN v5_sales_stores s ON s.channel_id=c.channel_id LEFT JOIN cafe_public_profiles p ON p.channel_id=c.channel_id WHERE '+where;
  const args=[Date.now(),kind,kind,country,country,search,term,term];
  const count=await c.env.DB.prepare('SELECT COUNT(*) total'+from).bind(...args).first<any>();
  const result=await c.env.DB.prepare("SELECT c.channel_id,c.name,c.country,c.addr,c.description,c.images,c.status,COALESCE(s.kind,'cafe') kind,COALESCE(p.profile_json,'{}') profile_json"+from+' ORDER BY c.created_at DESC,c.channel_id LIMIT ? OFFSET ?').bind(...args,limit,offset).all();
  return c.json({ok:true,channels:result.results||[],total:Number(count?.total||0),page,page_size:limit,has_more:offset+(result.results||[]).length<Number(count?.total||0)});
 }catch(_){return c.json({ok:false,error:'STORE_WORLD_UNAVAILABLE'},503);}
});
router.get('/me',async c=>{
 const uid=c.get('salesUser').id,db=c.env.DB;
 const [member,stores,owned,income]=await Promise.all([
 db.prepare('SELECT * FROM v5_sales_members WHERE user_id=?').bind(uid).first<any>(),
 db.prepare("SELECT c.channel_id,c.name,c.country,c.addr,s.kind,s.dj_id,s.version,d.dj_name FROM v5_sales_stores s JOIN cafe_channels c ON c.channel_id=s.channel_id LEFT JOIN dj_profiles d ON d.id=s.dj_id WHERE s.manager_user_id=? AND c.status='active' ORDER BY c.created_at DESC").bind(uid).all(),
 db.prepare("SELECT c.channel_id,c.name,c.country,c.expires_at,COALESCE(s.kind,'cafe') kind,s.manager_user_id,s.dj_id,COALESCE(s.version,0) version,m.display_name manager_name,d.dj_name FROM cafe_channels c LEFT JOIN v5_sales_stores s ON s.channel_id=c.channel_id LEFT JOIN v5_sales_members m ON m.user_id=s.manager_user_id LEFT JOIN dj_profiles d ON d.id=s.dj_id WHERE c.owner_id=? ORDER BY c.created_at DESC").bind(uid).all(),
 db.prepare("SELECT COALESCE(SUM(CASE WHEN manager_user_id=? THEN manager_atoms ELSE 0 END),0) manager_atoms,COALESCE(SUM(CASE WHEN manager_user_id=? THEN manager_paid_atoms ELSE 0 END),0) manager_paid_atoms,COALESCE(SUM(CASE WHEN dj_user_id=? THEN dj_atoms ELSE 0 END),0) dj_atoms,COALESCE(SUM(CASE WHEN dj_user_id=? THEN dj_paid_atoms ELSE 0 END),0) dj_paid_atoms FROM v5_sales_payments WHERE manager_user_id=? OR dj_user_id=?").bind(uid,uid,uid,uid,uid,uid).first()
 ]);
 return c.json({ok:true,user_id:uid,member,managed_stores:stores.results||[],owned_stores:owned.results||[],income,simulation:true});
});
router.post('/join',async c=>{try{return c.json({ok:true,...await signSalesContract(c.env.DB,c.get('salesUser').id,await c.req.json(),c.req.header('User-Agent'))});}catch(e:any){return c.json({ok:false,error:e.message},400);}});
router.post('/simulate-deposit',async c=>{try{return c.json({ok:true,...await simulateSalesDeposit(c.env.DB,c.get('salesUser').id)});}catch(e:any){return c.json({ok:false,error:e.message},400);}});
router.post('/stores/:id/assignment',async c=>{
 try{const uid=c.get('salesUser').id,cafe=await c.env.DB.prepare('SELECT channel_id,owner_id,country FROM cafe_channels WHERE channel_id=?').bind(c.req.param('id')).first();
 if(!cafe)return c.json({ok:false,error:'매장 없음'},404);
 const plan=await assignmentPlan(c.env.DB,cafe,uid,await c.req.json());await c.env.DB.batch(plan.statements);return c.json({ok:true,version:plan.version});
 }catch(e:any){return c.json({ok:false,error:e.message},403);}
});
router.post('/stores/:id/renew',async c=>{
 try{
 const uid=c.get('salesUser').id,id=c.req.param('id'),b=await c.req.json<any>(),p=await salesPolicy(c.env.DB);
 if(typeof b.request_id!=='string'||!/^[a-zA-Z0-9_-]{16,100}$/.test(b.request_id))return c.json({ok:false,error:'요청 번호 확인 필요'},400);
 const cafe=await c.env.DB.prepare('SELECT * FROM cafe_channels WHERE channel_id=? AND owner_id=? AND status=\'active\'').bind(id,uid).first<any>();if(!cafe)return c.json({ok:false,error:'상점주만 결제할 수 있습니다.'},403);
 const link=await c.env.DB.prepare('SELECT s.*,d.user_id dj_user_id FROM v5_sales_stores s LEFT JOIN dj_profiles d ON d.id=s.dj_id WHERE s.channel_id=?').bind(id).first<any>();
 const previous=Number(cafe.expires_at)||Date.parse(String(cafe.expires_at||''))||0;
 const expiry=Math.max(Date.now(),previous)+30*86400000;
 const guards=[c.env.DB.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM cafe_channels WHERE channel_id=? AND owner_id=? AND COALESCE(expires_at,0)=?) THEN 1 ELSE json_extract('invalid','$') END").bind(id,uid,cafe.expires_at??0)];
 if(link)guards.push(c.env.DB.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_sales_stores WHERE channel_id=? AND version=?) THEN 1 ELSE json_extract('invalid','$') END").bind(id,link.version));
 const result=await settleCafeService(c.env.DB,{payerId:uid,channelId:id,amountAtoms:tlToAtoms(p.monthly_fee_tl),key:'cafe:renew:'+id+':'+b.request_id,managerId:link?.manager_user_id,djUserId:link?.dj_user_id,guards,atomic:[c.env.DB.prepare('UPDATE cafe_channels SET expires_at=?,updated_at=? WHERE channel_id=?').bind(expiry,Date.now(),id)],metadata:{service:'monthly_broadcast',expires_at:expiry}});
 return c.json({ok:true,...result});
 }catch(e:any){return c.json({ok:false,error:e.message,current:e.current,required:e.required},e.status===402?402:409);}
});
router.get('/admin/finance',async c=>{
 if(c.get('salesUser').role!=='admin')return c.json({ok:false,error:'관리자 권한 필요'},403);
 try{return c.json(await readSalesFinance(c.env.DB,c.req.query('month')||new Date(Date.now()+9*3600000).toISOString().slice(0,7)));}catch(e:any){return c.json({ok:false,error:e.message},503);}
});
router.get('/admin/payments/:id',async c=>{
 if(c.get('salesUser').role!=='admin')return c.json({ok:false,error:'관리자 권한 필요'},403);
 const payment=await c.env.DB.prepare(`SELECT p.*,c.name store_name,m.display_name manager_name,d.dj_name,t.status ledger_status,t.metadata_json,j.id accounting_journal_id FROM v5_sales_payments p LEFT JOIN cafe_channels c ON c.channel_id=p.channel_id LEFT JOIN v5_sales_members m ON m.user_id=p.manager_user_id LEFT JOIN dj_profiles d ON d.user_id=p.dj_user_id LEFT JOIN v3_economy_transactions t ON t.id=p.ledger_transaction_id LEFT JOIN v5_kr_journals j ON j.source_key='sales:service:'||p.id AND j.status='posted' WHERE p.id=?`).bind(c.req.param('id')).first();
 return payment?c.json({ok:true,payment}):c.json({ok:false,error:'원거래 없음'},404);
});
router.get('/admin/settlements/:id',async c=>{
 if(c.get('salesUser').role!=='admin')return c.json({ok:false,error:'관리자 권한 필요'},403);
 const id=c.req.param('id'),settlement=await c.env.DB.prepare('SELECT * FROM v5_sales_settlements WHERE id=?').bind(id).first();if(!settlement)return c.json({ok:false,error:'정산 없음'},404);
 const [items,events]=await Promise.all([c.env.DB.prepare('SELECT i.*,p.channel_id,p.ledger_transaction_id,c.name store_name FROM v5_sales_settlement_items i JOIN v5_sales_payments p ON p.id=i.payment_id LEFT JOIN cafe_channels c ON c.channel_id=p.channel_id WHERE i.settlement_id=?').bind(id).all(),c.env.DB.prepare('SELECT * FROM v5_sales_settlement_events WHERE settlement_id=? ORDER BY created_at,id').bind(id).all()]);
 return c.json({ok:true,settlement,items:items.results||[],events:events.results||[]});
});
router.post('/admin/settlements',async c=>{
 if(c.get('salesUser').role!=='admin')return c.json({ok:false,error:'관리자 권한 필요'},403);
 try{return c.json({ok:true,...await createSalesSettlement(c.env.DB,await c.req.json(),c.get('salesUser').id)});}catch(e:any){return c.json({ok:false,error:e.message},400);}
});
router.post('/admin/settlements/:id/:action',async c=>{
 if(c.get('salesUser').role!=='admin')return c.json({ok:false,error:'관리자 권한 필요'},403);
 try{return c.json({ok:true,...await transitionSalesSettlement(c.env.DB,c.req.param('id'),c.req.param('action'),await c.req.json(),c.get('salesUser').id)});}catch(e:any){return c.json({ok:false,error:e.message},400);}
});
router.get('/admin',async c=>{
 if(c.get('salesUser').role!=='admin')return c.json({ok:false,error:'관리자 권한 필요'},403);
 const rows=await c.env.DB.prepare('SELECT user_id,country,display_name,state,fee_krw,signed_at,signature_hash,virtual_ref,activation_basis,review_note FROM v5_sales_members ORDER BY signed_at DESC LIMIT 300').all();
 const events=await c.env.DB.prepare('SELECT * FROM v5_sales_member_events ORDER BY created_at DESC LIMIT 100').all();
 return c.json({ok:true,policy:await salesPolicy(c.env.DB),applications:rows.results||[],events:events.results||[]});
});
router.get('/admin/contracts/:userId',async c=>{
 if(c.get('salesUser').role!=='admin')return c.json({ok:false,error:'관리자 권한 필요'},403);
 const contract=await c.env.DB.prepare('SELECT * FROM v5_sales_members WHERE user_id=?').bind(Number(c.req.param('userId'))).first();
 return contract?c.json({ok:true,contract}):c.json({ok:false,error:'계약 없음'},404);
});
router.post('/admin/:action',async c=>{
 if(c.get('salesUser').role!=='admin')return c.json({ok:false,error:'관리자 권한 필요'},403);
 try{const b=await c.req.json(),actor=c.get('salesUser').id;const data=c.req.param('action')==='policy'?await updateSalesPolicy(c.env.DB,b,actor):c.req.param('action')==='review'?await reviewSalesMember(c.env.DB,b,actor):null;if(!data)return c.json({ok:false,error:'알 수 없는 작업'},404);return c.json({ok:true,data});}catch(e:any){return c.json({ok:false,error:e.message},400);}
});
export default router;
