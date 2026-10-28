import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';

// Store-funded third bonus. No platform TL or cash balance is ever credited here.
// Activation must be tied to a server-verified paid time-order in a later checkout integration.
const router=new Hono<{Bindings:Env}>();
async function user(c:any){const header=c.req.header('Authorization')||'';const token=header.replace(/^Bearer\s+/i,'').trim();const claim=token?await verifyToken(token,c.env.JWT_SECRET):null;const id=Number(claim?.sub||0);return Number.isSafeInteger(id)&&id>0?id:null;}
async function schema(db:any){
 await db.prepare("CREATE TABLE IF NOT EXISTS v5_store_bonus_campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, store_owner_id INTEGER NOT NULL, store_label TEXT NOT NULL, title TEXT NOT NULL, benefit_type TEXT NOT NULL, benefit_value INTEGER NOT NULL, max_issues INTEGER NOT NULL, issued_count INTEGER NOT NULL DEFAULT 0, expires_days INTEGER NOT NULL DEFAULT 30, enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
 await db.prepare("CREATE TABLE IF NOT EXISTS v5_store_bonus_coupons (id INTEGER PRIMARY KEY AUTOINCREMENT, campaign_id INTEGER NOT NULL, user_id INTEGER NOT NULL, order_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'issued', issued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, redeemed_at TEXT, expires_at TEXT NOT NULL)").run();
}
router.get('/campaigns',async c=>{try{await schema(c.env.DB);const rows=await c.env.DB.prepare("SELECT id,store_label,title,benefit_type,benefit_value,expires_days FROM v5_store_bonus_campaigns WHERE enabled=1 AND issued_count<max_issues ORDER BY id DESC LIMIT 100").all();return c.json({ok:true,campaigns:rows.results||[]});}catch{return c.json({ok:false,code:'BONUS_UNAVAILABLE'},503);}});
router.get('/mine',async c=>{const id=await user(c);if(!id)return c.json({ok:false,code:'AUTH_REQUIRED'},401);try{await schema(c.env.DB);const rows=await c.env.DB.prepare("SELECT cp.id,cp.status,cp.expires_at,ca.store_label,ca.title FROM v5_store_bonus_coupons cp JOIN v5_store_bonus_campaigns ca ON ca.id=cp.campaign_id WHERE cp.user_id=? ORDER BY cp.id DESC LIMIT 100").bind(id).all();return c.json({ok:true,coupons:rows.results||[]});}catch{return c.json({ok:false,code:'BONUS_UNAVAILABLE'},503);}});
router.post('/campaigns',async c=>{const id=await user(c);if(!id)return c.json({ok:false,code:'AUTH_REQUIRED'},401);let b:any;try{b=await c.req.json();}catch{return c.json({ok:false,code:'INVALID_BODY'},400);}
const title=String(b.title||'').trim(),store=String(b.store_label||'').trim(),type=String(b.benefit_type||'');
const value=Number(b.benefit_value),max=Number(b.max_issues),days=Number(b.expires_days||30);
if(title.length<2||title.length>80||store.length<2||store.length>80||!['percent','fixed_krw','gift'].includes(type)||!Number.isSafeInteger(value)||value<1||(type==='percent'&&value>50)||(type==='fixed_krw'&&value>10000)||(type==='gift'&&value!==1)||!Number.isSafeInteger(max)||max<1||max>10000||!Number.isSafeInteger(days)||days<1||days>90)return c.json({ok:false,code:'INVALID_CAMPAIGN'},400);
try{await schema(c.env.DB);const r=await c.env.DB.prepare("INSERT INTO v5_store_bonus_campaigns(store_owner_id,store_label,title,benefit_type,benefit_value,max_issues,expires_days,enabled) VALUES(?,?,?,?,?,?,?,0)").bind(id,store,title,type,value,max,days).run();return c.json({ok:true,id:r.meta?.last_row_id,status:'pending_store_verification',note:'Campaign remains disabled until store ownership is verified'});}catch{return c.json({ok:false,code:'BONUS_UNAVAILABLE'},503);}
});
// Intentionally no public issue/redeem endpoints: verified checkout and store operator authorization required.
export default router;
