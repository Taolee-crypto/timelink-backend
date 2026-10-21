import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';

const router = new Hono<{ Bindings: Env }>();

async function adminId(c: any): Promise<number | null> {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  const claims = await verifyToken(token, c.env.JWT_SECRET).catch(() => null);
  const id = Number(claims?.sub || 0);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const row = await c.env.DB.prepare('SELECT role FROM users WHERE id=?').bind(id).first() as { role?: string } | null;
  return row?.role === 'admin' ? id : null;
}

// Read-only foundation. No deletion until every relationship is audited.
router.get('/members', async c => {
  if (!await adminId(c)) return c.json({error:'관리자 권한 필요'}, 403);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 50)));
  const offset = Math.max(0, Number(c.req.query('offset') || 0));
  const rows = await c.env.DB.prepare(
    'SELECT id,email,username,role,is_active,account_forfeited,created_at FROM users ORDER BY id LIMIT ? OFFSET ?'
  ).bind(limit, offset).all();
  return c.json({ok:true, members:rows.results || []});
});

router.get('/members/:id/deletion-preview', async c => {
  const actor = await adminId(c);
  if (!actor) return c.json({error:'관리자 권한 필요'}, 403);
  const id = Number(c.req.param('id'));
  if (!Number.isSafeInteger(id) || id <= 0) return c.json({error:'잘못된 회원 ID'},400);
  const member = await c.env.DB.prepare('SELECT id,email,username,role FROM users WHERE id=?').bind(id).first();
  if (!member) return c.json({error:'회원 없음'},404);
  const tables = [
    ['ad_views','user_id'],['auth_requests','user_id'],['auth_verifications','user_id'],
    ['cafe_channels','owner_id'],['cafe_staff_members','user_id'],['cafe_subscriptions','owner_id'],
    ['comments','user_id'],['creator_payouts','user_id'],['discount_uses','user_id'],
    ['disputes','disputer_user_id'],['dj_profiles','user_id'],['exchanges','user_id'],
    ['incar_channels','owner_id'],['play_events','player_user_id'],
    ['playlist_subscribers','user_id'],['playlists','user_id'],
    ['poc_action_logs','user_id'],['poc_events','user_id'],['poc_logs','user_id'],
    ['social_comments','user_id'],['social_likes','user_id'],
    ['storage_connections','user_id'],['storage_oauth_states','user_id'],['storage_objects','user_id'],
    ['tl3_offline_grants','user_id'],['tl3_offline_sessions','user_id'],
    ['tl3_play_blocks','user_id'],['tl3_play_charges','user_id'],
    ['tl3_play_meter_sessions','user_id'],['tl3_player_keys','user_id'],
    ['tl3_releases','user_id'],['tl3_spine_v4_releases','user_id'],
    ['tl3_stream_sessions','user_id'],['tl3_v5_releases','user_id'],
    ['tl3_v5_sessions','user_id'],['tl3_v5_track_metadata','user_id'],
    ['tl_asset_events','actor_user_id'],['tl_assets','owner_user_id'],
    ['tl_cert_downloads','user_id'],['tl_creator_metadata','user_id'],
    ['tl_d1_upload_sessions','owner_id'],['tl_files','user_id'],
    ['tl_ledger','user_id'],['tl_playlists','user_id'],['tl_shares','user_id'],
    ['tl_user_files','user_id'],['tlc_mining_logs','user_id'],
    ['tlc_withdrawals','user_id'],['transactions','user_id'],
    ['user_auth_level','user_id'],['user_likes','user_id'],
    ['user_trust_score','user_id'],['wm_logs','user_id']
  ] as const;
  const counts: Record<string,number> = {};
  for (const [table,column] of tables) {
    const row = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}"=?`).bind(id).first<{n:number}>();
    counts[table] = Number(row?.n || 0);
  }
  return c.json({ok:true,member,counts,can_delete:false,
    reason:'간접 참조, 결제·정산 보존 의무 및 연관 데이터 검증 전 삭제 잠금'});
});

router.delete('/members/:id', async c => {
  if (!await adminId(c)) return c.json({error:'관리자 권한 필요'},403);
  return c.json({ok:false,error:'안전성 검증 전 회원 삭제가 잠겨 있습니다.'},423);
});

export default router;
