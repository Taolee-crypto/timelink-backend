import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';
const router=new Hono<{Bindings:Env}>();
async function viewer(c:any){
  const token=(c.req.header('Authorization')||'').replace(/^Bearer\s+/i,'');
  const payload=await verifyToken(token,c.env.JWT_SECRET).catch(()=>null);
  if(!payload)return null;
  return c.env.DB.prepare('SELECT id,role,username FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0').bind(payload.sub).first();
}
export async function ensureCommunity(db:D1Database){
  for(const sql of [
    `CREATE TABLE IF NOT EXISTS v5_channel_comments(id TEXT PRIMARY KEY,kind TEXT NOT NULL,channel_id TEXT NOT NULL,user_id INTEGER NOT NULL,body TEXT NOT NULL,status TEXT DEFAULT 'visible',created_at TEXT DEFAULT(datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS v5_channel_likes(kind TEXT,channel_id TEXT,user_id INTEGER,created_at TEXT DEFAULT(datetime('now')),PRIMARY KEY(kind,channel_id,user_id))`,
    `CREATE TABLE IF NOT EXISTS v5_community_reports(id TEXT PRIMARY KEY,comment_id TEXT NOT NULL,user_id INTEGER NOT NULL,reason TEXT NOT NULL,state TEXT DEFAULT 'pending',reviewed_by INTEGER,reviewed_at TEXT,created_at TEXT DEFAULT(datetime('now')),UNIQUE(comment_id,user_id))`,
    `CREATE INDEX IF NOT EXISTS idx_v5_channel_comments ON v5_channel_comments(kind,channel_id,status,created_at)`
  ])await db.prepare(sql).run();
}
router.use('/:kind/:channel/*',async(c,next)=>{
  const kind=c.req.param('kind'),id=c.req.param('channel');
  if(kind==='moderation'){await next();return;}
  if(!['cafe','incar'].includes(kind)||!/^[a-zA-Z0-9_-]{1,100}$/.test(id))return c.json({error:'INVALID_CHANNEL'},400);
  const table=kind==='cafe'?'cafe_channels':'incar_channels';
  const row=await c.env.DB.prepare(`SELECT channel_id FROM ${table} WHERE channel_id=? AND status='active'`).bind(id).first();
  if(!row)return c.json({error:'CHANNEL_NOT_FOUND'},404);
  await ensureCommunity(c.env.DB);await next();
});
router.get('/:kind/:channel/thread',async c=>{
  const kind=c.req.param('kind'),id=c.req.param('channel'),user=await viewer(c);
  const cursor=c.req.query('before')||new Date(Date.now()+1000).toISOString().replace('T',' ').slice(0,19);
  const comments=await c.env.DB.prepare(`SELECT c.id,c.user_id,u.username,c.body,c.created_at
    FROM v5_channel_comments c JOIN users u ON u.id=c.user_id
    WHERE c.kind=? AND c.channel_id=? AND c.status='visible' AND c.created_at<? ORDER BY c.created_at DESC,c.id DESC LIMIT 50`).bind(kind,id,cursor).all();
  const count=await c.env.DB.prepare('SELECT COUNT(*) AS n FROM v5_channel_likes WHERE kind=? AND channel_id=?').bind(kind,id).first<any>();
  const mine=user?await c.env.DB.prepare('SELECT 1 FROM v5_channel_likes WHERE kind=? AND channel_id=? AND user_id=?').bind(kind,id,user.id).first():null;
  return c.json({ok:true,comments:comments.results||[],likes:Number(count?.n||0),my_like:!!mine,viewer_id:user?.id||null});
});
router.post('/:kind/:channel/comments',async c=>{
  const user=await viewer(c);if(!user)return c.json({error:'LOGIN_REQUIRED'},401);
  const body=await c.req.json<any>().catch(()=>({})),text=String(body.body||'').trim();
  if(!text||text.length>2000)return c.json({error:'댓글은 1~2,000자입니다.'},400);
  const id=crypto.randomUUID();
  const r=await c.env.DB.prepare(`INSERT INTO v5_channel_comments(id,kind,channel_id,user_id,body)
    SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM v5_channel_comments WHERE user_id=? AND created_at>datetime('now','-1 minute'))<10`)
    .bind(id,c.req.param('kind'),c.req.param('channel'),user.id,text,user.id).run();
  if(!r.meta?.changes)return c.json({error:'잠시 후 다시 작성해 주세요.'},429);
  return c.json({ok:true,id},201);
});
router.put('/:kind/:channel/like',async c=>{
  const user=await viewer(c);if(!user)return c.json({error:'LOGIN_REQUIRED'},401);
  await c.env.DB.prepare('INSERT OR IGNORE INTO v5_channel_likes(kind,channel_id,user_id) VALUES(?,?,?)').bind(c.req.param('kind'),c.req.param('channel'),user.id).run();
  return c.json({ok:true});
});
router.delete('/:kind/:channel/like',async c=>{
  const user=await viewer(c);if(!user)return c.json({error:'LOGIN_REQUIRED'},401);
  await c.env.DB.prepare('DELETE FROM v5_channel_likes WHERE kind=? AND channel_id=? AND user_id=?').bind(c.req.param('kind'),c.req.param('channel'),user.id).run();
  return c.json({ok:true});
});
router.delete('/:kind/:channel/comments/:id',async c=>{
  const user=await viewer(c);if(!user)return c.json({error:'LOGIN_REQUIRED'},401);
  const r=await c.env.DB.prepare(`UPDATE v5_channel_comments SET status='hidden' WHERE id=? AND kind=? AND channel_id=? AND (user_id=? OR ?='admin')`)
    .bind(c.req.param('id'),c.req.param('kind'),c.req.param('channel'),user.id,user.role).run();
  return c.json({ok:!!r.meta?.changes},r.meta?.changes?200:404);
});
router.post('/:kind/:channel/comments/:id/report',async c=>{
  const user=await viewer(c);if(!user)return c.json({error:'LOGIN_REQUIRED'},401);
  const input=await c.req.json<any>().catch(()=>({}));const reason=String(input.reason||'').trim();
  if(!reason||reason.length>500)return c.json({error:'신고 사유를 입력하세요(최대 500자).'},400);
  const comment=await c.env.DB.prepare("SELECT id FROM v5_channel_comments WHERE id=? AND kind=? AND channel_id=? AND status='visible'").bind(c.req.param('id'),c.req.param('kind'),c.req.param('channel')).first();
  if(!comment)return c.json({error:'COMMENT_NOT_FOUND'},404);
  await c.env.DB.prepare('INSERT OR IGNORE INTO v5_community_reports(id,comment_id,user_id,reason) VALUES(?,?,?,?)').bind(crypto.randomUUID(),c.req.param('id'),user.id,reason).run();
  return c.json({ok:true});
});
router.get('/moderation/reports',async c=>{
  if((await viewer(c))?.role!=='admin')return c.json({error:'ADMIN_REQUIRED'},403);
  await ensureCommunity(c.env.DB);
  const rows=await c.env.DB.prepare(`SELECT r.*,c.body,c.kind,c.channel_id FROM v5_community_reports r
    JOIN v5_channel_comments c ON c.id=r.comment_id WHERE r.state='pending' ORDER BY r.created_at LIMIT 100`).all();
  return c.json({ok:true,reports:rows.results||[]});
});
router.post('/moderation/reports/:id',async c=>{
  const user=await viewer(c);if(user?.role!=='admin')return c.json({error:'ADMIN_REQUIRED'},403);
  const input=await c.req.json<any>();if(!['hide','dismiss'].includes(input.action))return c.json({error:'INVALID_ACTION'},400);
  await ensureCommunity(c.env.DB);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE v5_channel_comments SET status='hidden' WHERE id IN
      (SELECT comment_id FROM v5_community_reports WHERE id=? AND state='pending') AND ?='hide'`).bind(c.req.param('id'),input.action),
    c.env.DB.prepare("UPDATE v5_community_reports SET state=?,reviewed_by=?,reviewed_at=datetime('now') WHERE id=? AND state='pending'").bind(input.action,user.id,c.req.param('id'))]);
  return c.json({ok:true});
});
export default router;
