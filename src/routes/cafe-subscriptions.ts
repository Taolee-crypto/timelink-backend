import { Hono } from 'hono';
import { authMiddleware } from '../middleware';
import type { Env, User } from '../types';

const router = new Hono<{ Bindings: Env; Variables: { user: User } }>();

// ── POST /trial — 카페 3개월 무료 체험 시작 ──
router.post('/trial', authMiddleware as any, async (c) => {
  const u = c.get('user');
  const body = await c.req.json<any>().catch(() => ({}));
  const channelId = String(body.channel_id || '').trim();
  const trialDays = Math.max(1, Math.min(180, Number(body.trial_days) || 90));

  if (!channelId) return c.json({ ok: false, error: 'channel_id 필요' }, 400);

  const cafe = await c.env.DB.prepare(
    'SELECT id, channel_id, name, owner_id, expires_at FROM cafe_channels WHERE channel_id=?'
  ).bind(channelId).first<any>();
  if (!cafe) return c.json({ ok: false, error: '카페 없음' }, 404);
  if (Number(cafe.owner_id) !== Number(u.id)) return c.json({ ok: false, error: '권한 없음' }, 403);

  const existing = await c.env.DB.prepare(
    "SELECT id, status FROM cafe_subscriptions WHERE cafe_channel_id=? AND status IN ('trialing','active','past_due')"
  ).bind(channelId).first<any>();
  if (existing) return c.json({ ok: false, error: '이미 구독 중', subscription_id: existing.id, status: existing.status }, 409);

  const now = Date.now();
  const trialEnds = now + trialDays * 24 * 60 * 60 * 1000;

  const ins = await c.env.DB.prepare(
    "INSERT INTO cafe_subscriptions (cafe_channel_id, owner_id, plan, status, trial_started_at, trial_ends_at, amount_tl, auto_renew, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
  ).bind(channelId, u.id, 'basic', 'trialing', now, trialEnds, 0, 1, now, now).run();

  await c.env.DB.prepare(
    'UPDATE cafe_channels SET expires_at=?, updated_at=? WHERE channel_id=?'
  ).bind(trialEnds, now, channelId).run();

  await c.env.DB.prepare(
    'INSERT INTO subscription_events (subscription_id, event_type, amount_tl, metadata, created_at) VALUES (?,?,?,?,?)'
  ).bind(ins.meta?.last_row_id || 0, 'trial_started', 0, JSON.stringify({ trial_days: trialDays }), now).run();

  return c.json({
    ok: true,
    subscription_id: ins.meta?.last_row_id,
    trial_started_at: now,
    trial_ends_at: trialEnds,
    trial_days: trialDays,
    next_amount_tl: 50000
  });
});

// ── GET /current — 내 카페 구독 상태 ──
router.get('/current', authMiddleware as any, async (c) => {
  const u = c.get('user');
  const channelId = c.req.query('channel_id') || '';
  if (!channelId) return c.json({ ok: false, error: 'channel_id 필요' }, 400);

  const sub = await c.env.DB.prepare(
    'SELECT * FROM cafe_subscriptions WHERE cafe_channel_id=? AND owner_id=? ORDER BY id DESC LIMIT 1'
  ).bind(channelId, u.id).first<any>();

  if (!sub) return c.json({ ok: true, subscription: null });

  const now = Date.now();
  const daysLeft = sub.trial_ends_at ? Math.max(0, Math.ceil((sub.trial_ends_at - now) / 86400000)) : 0;

  return c.json({ ok: true, subscription: { ...sub, days_left: daysLeft } });
});

// ── POST /cancel — 해지 (기간 끝까지 유지) ──
router.post('/cancel', authMiddleware as any, async (c) => {
  const u = c.get('user');
  const body = await c.req.json<any>().catch(() => ({}));
  const subId = Number(body.subscription_id);
  if (!subId) return c.json({ ok: false, error: 'subscription_id 필요' }, 400);

  const sub = await c.env.DB.prepare(
    'SELECT id, status FROM cafe_subscriptions WHERE id=? AND owner_id=?'
  ).bind(subId, u.id).first<any>();
  if (!sub) return c.json({ ok: false, error: '구독 없음' }, 404);

  const now = Date.now();
  await c.env.DB.prepare(
    'UPDATE cafe_subscriptions SET cancel_at_period_end=1, canceled_at=?, updated_at=? WHERE id=?'
  ).bind(now, now, subId).run();

  await c.env.DB.prepare(
    'INSERT INTO subscription_events (subscription_id, event_type, created_at) VALUES (?,?,?)'
  ).bind(subId, 'cancel_scheduled', now).run();

  return c.json({ ok: true, cancel_at_period_end: true });
});

// ── POST /reactivate — 해지 취소 ──
router.post('/reactivate', authMiddleware as any, async (c) => {
  const u = c.get('user');
  const body = await c.req.json<any>().catch(() => ({}));
  const subId = Number(body.subscription_id);
  if (!subId) return c.json({ ok: false, error: 'subscription_id 필요' }, 400);

  const now = Date.now();
  const r = await c.env.DB.prepare(
    'UPDATE cafe_subscriptions SET cancel_at_period_end=0, canceled_at=NULL, updated_at=? WHERE id=? AND owner_id=?'
  ).bind(now, subId, u.id).run();

  if (!r.meta?.changes) return c.json({ ok: false, error: '구독 없음' }, 404);

  await c.env.DB.prepare(
    'INSERT INTO subscription_events (subscription_id, event_type, created_at) VALUES (?,?,?)'
  ).bind(subId, 'reactivated', now).run();

  return c.json({ ok: true });
});


router.post('/discounts/validate', async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const code = String(body.code || '').trim().toUpperCase();
  const appliesTo = String(body.applies_to || '').trim();
  const amount = Number(body.amount || 0);
  if (!code || !appliesTo) return c.json({ ok: false, error: 'code와 applies_to 필요' }, 400);
  const d = await c.env.DB.prepare('SELECT * FROM discounts WHERE code=? AND applies_to=? AND is_active=1').bind(code, appliesTo).first<any>();
  if (!d) return c.json({ ok: false, error: '유효하지 않은 코드' }, 404);
  const now = Date.now();
  if (d.starts_at && d.starts_at > now) return c.json({ ok: false, error: '아직 시작 전' }, 400);
  if (d.expires_at && d.expires_at < now) return c.json({ ok: false, error: '만료된 코드' }, 400);
  if (d.max_uses && d.uses >= d.max_uses) return c.json({ ok: false, error: '사용 한도 초과' }, 400);
  let discountAmount = 0;
  if (d.type === 'percent') discountAmount = amount * (d.value / 100);
  else if (d.type === 'fixed') discountAmount = d.value;
  discountAmount = Math.min(amount, Math.max(0, discountAmount));
  return c.json({ ok: true, code: d.code, name: d.name, type: d.type, value: d.value, discount: discountAmount, final_amount: amount - discountAmount });
});

router.get('/promotions/active', async (c) => {
  const now = Date.now();
  const audience = c.req.query('audience') || '';
  let sql = 'SELECT * FROM promotions WHERE is_active=1';
  const params: any[] = [];
  if (audience) { sql += " AND (target_audience=? OR target_audience='all')"; params.push(audience); }
  sql += ' AND (starts_at IS NULL OR starts_at <= ?) AND (expires_at IS NULL OR expires_at >= ?) ORDER BY id DESC LIMIT 20';
  const { results } = await c.env.DB.prepare(sql).bind(...params, now, now).all();
  return c.json({ ok: true, promotions: results || [] });
});

export default router;
