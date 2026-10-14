import { Hono } from 'hono';
import { authMiddleware } from '../middleware';
import type { Env, User } from '../types';

const router = new Hono<{ Bindings: Env; Variables: { user: User } }>();
const makeId = () => crypto.randomUUID();
const clean = (v: unknown, max: number) => String(v || '').trim().slice(0,max);

async function visibleTrack(db: D1Database, trackId: string) {
  return db.prepare(`
    SELECT t.id,t.owner_user_id FROM v3_tracks t
    JOIN v3_shareplace_entries s ON s.track_id=t.id AND s.visibility='public'
    JOIN v3_track_releases r ON r.track_id=t.id AND r.release_type='MP3' AND r.status='published'
    JOIN v3_track_assets a ON a.id=r.asset_id AND a.asset_type='mp3_audio'
      AND a.availability_status='available' AND a.storage_uri_ref IS NOT NULL
    WHERE t.id=? AND t.status='active' AND t.visibility='public'
  `).bind(trackId).first<any>();
}

router.get('/:trackId/stats', async (c) => {
  const trackId=c.req.param('trackId');
  if(!await visibleTrack(c.env.DB,trackId)) return c.json({ok:false,error:'Track not found'},404);
  const [likes,comments]=await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM v3_track_likes WHERE track_id=?').bind(trackId).first<any>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM v3_track_comments WHERE track_id=? AND moderation_status='visible'").bind(trackId).first<any>()
  ]);
  return c.json({ok:true,likes:Number(likes?.n||0),comments:Number(comments?.n||0),views:0,views_tracked:false});
});

router.get('/:trackId/comments', async (c) => {
  const trackId=c.req.param('trackId');
  if(!await visibleTrack(c.env.DB,trackId)) return c.json({ok:false,error:'Track not found'},404);
  const rows=await c.env.DB.prepare(`
    SELECT cm.id,cm.user_id,u.username,cm.content,cm.created_at
    FROM v3_track_comments cm JOIN users u ON u.id=cm.user_id
    WHERE cm.track_id=? AND cm.moderation_status='visible'
    ORDER BY cm.created_at DESC LIMIT 100
  `).bind(trackId).all();
  return c.json({ok:true,comments:rows.results||[]});
});

router.post('/:trackId/like',authMiddleware,async (c) => {
  const trackId=c.req.param('trackId'),user=c.get('user');
  if(!await visibleTrack(c.env.DB,trackId)) return c.json({ok:false,error:'Track not found'},404);
  await c.env.DB.prepare('INSERT OR IGNORE INTO v3_track_likes(id,track_id,user_id) VALUES(?,?,?)').bind(makeId(),trackId,user.id).run();
  const count=await c.env.DB.prepare('SELECT COUNT(*) AS n FROM v3_track_likes WHERE track_id=?').bind(trackId).first<any>();
  return c.json({ok:true,liked:true,likes:Number(count?.n||0)});
});

router.delete('/:trackId/like',authMiddleware,async (c) => {
  const trackId=c.req.param('trackId'),user=c.get('user');
  if(!await visibleTrack(c.env.DB,trackId)) return c.json({ok:false,error:'Track not found'},404);
  await c.env.DB.prepare('DELETE FROM v3_track_likes WHERE track_id=? AND user_id=?').bind(trackId,user.id).run();
  const count=await c.env.DB.prepare('SELECT COUNT(*) AS n FROM v3_track_likes WHERE track_id=?').bind(trackId).first<any>();
  return c.json({ok:true,liked:false,likes:Number(count?.n||0)});
});

router.post('/:trackId/comments',authMiddleware,async (c) => {
  const trackId=c.req.param('trackId'),user=c.get('user');
  if(!await visibleTrack(c.env.DB,trackId)) return c.json({ok:false,error:'Track not found'},404);
  let body:any;try{body=await c.req.json()}catch{return c.json({ok:false,error:'Invalid JSON body'},400);}
  const content=clean(body.content,1000);
  if(!content) return c.json({ok:false,error:'Comment is required'},422);
  const recent=await c.env.DB.prepare("SELECT id FROM v3_track_comments WHERE track_id=? AND user_id=? AND created_at>=datetime('now','-5 seconds') LIMIT 1").bind(trackId,user.id).first();
  if(recent) return c.json({ok:false,error:'Please wait before posting another comment'},429);
  const commentId=makeId();
  await c.env.DB.prepare("INSERT INTO v3_track_comments(id,track_id,user_id,content) VALUES(?,?,?,?)").bind(commentId,trackId,user.id,content).run();
  const comment=await c.env.DB.prepare('SELECT cm.id,cm.user_id,u.username,cm.content,cm.created_at FROM v3_track_comments cm JOIN users u ON u.id=cm.user_id WHERE cm.id=?').bind(commentId).first();
  return c.json({ok:true,comment},201);
});

router.post('/:trackId/follow',authMiddleware,async (c) => {
  const trackId=c.req.param('trackId'),user=c.get('user');
  const track=await visibleTrack(c.env.DB,trackId);
  if(!track) return c.json({ok:false,error:'Track not found'},404);
  if(Number(track.owner_user_id)===Number(user.id)) return c.json({ok:false,error:'You cannot follow yourself'},409);
  await c.env.DB.prepare('INSERT OR IGNORE INTO v3_track_follows(id,follower_user_id,followed_user_id) VALUES(?,?,?)').bind(makeId(),user.id,track.owner_user_id).run();
  const count=await c.env.DB.prepare('SELECT COUNT(*) AS n FROM v3_track_follows WHERE followed_user_id=?').bind(track.owner_user_id).first<any>();
  return c.json({ok:true,following:true,followers:Number(count?.n||0)});
});

router.delete('/:trackId/follow',authMiddleware,async (c) => {
  const trackId=c.req.param('trackId'),user=c.get('user');
  const track=await visibleTrack(c.env.DB,trackId);
  if(!track) return c.json({ok:false,error:'Track not found'},404);
  await c.env.DB.prepare('DELETE FROM v3_track_follows WHERE follower_user_id=? AND followed_user_id=?').bind(user.id,track.owner_user_id).run();
  const count=await c.env.DB.prepare('SELECT COUNT(*) AS n FROM v3_track_follows WHERE followed_user_id=?').bind(track.owner_user_id).first<any>();
  return c.json({ok:true,following:false,followers:Number(count?.n||0)});
});

router.post('/comments/:commentId/report',authMiddleware,async (c) => {
  const commentId=c.req.param('commentId'),user=c.get('user');
  let body:any;try{body=await c.req.json()}catch{return c.json({ok:false,error:'Invalid JSON body'},400);}
  const reason=clean(body.reason,1000);
  if(!reason) return c.json({ok:false,error:'Report reason is required'},422);
  const comment=await c.env.DB.prepare("SELECT id FROM v3_track_comments WHERE id=? AND moderation_status='visible'").bind(commentId).first();
  if(!comment) return c.json({ok:false,error:'Comment not found'},404);
  try{
    await c.env.DB.prepare('INSERT INTO v3_track_comment_reports(id,comment_id,reporter_user_id,reason) VALUES(?,?,?,?)').bind(makeId(),commentId,user.id,reason).run();
  }catch(e:any){
    if(String(e?.message||'').toLowerCase().includes('unique')) return c.json({ok:false,error:'You have already reported this comment'},409);
    throw e;
  }
  return c.json({ok:true,reported:true},201);
});

export default router;
