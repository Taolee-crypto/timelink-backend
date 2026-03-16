// ── 광고 플랫폼 백엔드 라우트 (ads.ts) ──────────────────────────────────
// index.ts에 추가:
//   import adsRouter from './ads';
//   app.route('/api/ads', adsRouter);

import { Hono } from 'hono';
import type { Env } from './types';

const ads = new Hono<{ Bindings: Env }>();

function parseUserId(token: string): number {
  const m = token.match(/(?:token|fallback)_(\d+)/);
  if (m) return Number(m[1]);
  if (token.split('.').length === 3) {
    try {
      const p = JSON.parse(atob(token.split('.')[1]));
      return Number(p.userId || p.id || p.sub || 0);
    } catch { return 0; }
  }
  return 0;
}

// ── DB 테이블 생성 헬퍼 ──
async function ensureTables(db: any) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS tl_ads (
    id TEXT PRIMARY KEY,
    advertiser_id INTEGER NOT NULL,
    business_name TEXT DEFAULT '',
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    ad_type TEXT DEFAULT 'video',
    media_url TEXT DEFAULT '',
    thumbnail_url TEXT DEFAULT '',
    target_url TEXT DEFAULT '',
    tl_reward INTEGER DEFAULT 300,
    budget_tl INTEGER DEFAULT 10000,
    spent_tl INTEGER DEFAULT 0,
    daily_limit INTEGER DEFAULT 100,
    status TEXT DEFAULT 'active',
    start_date TEXT DEFAULT '',
    end_date TEXT DEFAULT '',
    views INTEGER DEFAULT 0,
    completions INTEGER DEFAULT 0,
    clicks INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run().catch(() => {});

  await db.prepare(`CREATE TABLE IF NOT EXISTS ad_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ad_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    completed INTEGER DEFAULT 0,
    clicked INTEGER DEFAULT 0,
    tl_rewarded INTEGER DEFAULT 0,
    duration_watched INTEGER DEFAULT 0,
    viewed_at TEXT DEFAULT (datetime('now'))
  )`).run().catch(() => {});
}

// ── 광고 목록 (유저용: 시청 가능한 광고) ──
ads.get('/available', async (c) => {
  try {
    await ensureTables(c.env.DB);
    const token = (c.req.header('Authorization') || '').replace('Bearer ', '');
    const userId = parseUserId(token);

    const result = await c.env.DB.prepare(`
      SELECT a.*,
        COALESCE(
          (SELECT COUNT(*) FROM ad_views v WHERE v.ad_id=a.id AND v.user_id=? AND DATE(v.viewed_at)=DATE('now')),
          0
        ) as viewed_today
      FROM tl_ads a
      WHERE a.status='active'
        AND (a.spent_tl < a.budget_tl OR a.budget_tl = 0)
      ORDER BY a.tl_reward DESC, a.created_at DESC
      LIMIT 20
    `).bind(userId || 0).all();

    return c.json({ ads: result.results || [] });
  } catch (e: any) {
    return c.json({ ads: [], error: e.message });
  }
});

// ── 광고 시청 완료 → TL 지급 ──
ads.post('/:id/complete', async (c) => {
  try {
    await ensureTables(c.env.DB);
    const adId = c.req.param('id');
    const token = (c.req.header('Authorization') || '').replace('Bearer ', '');
    const userId = parseUserId(token);
    if (!userId) return c.json({ error: '로그인 필요' }, 401);

    const body = await c.req.json<any>().catch(() => ({}));

    // 오늘 이미 시청했는지 체크
    const already = await c.env.DB.prepare(
      `SELECT id FROM ad_views WHERE ad_id=? AND user_id=? AND DATE(viewed_at)=DATE('now') AND completed=1`
    ).bind(adId, userId).first();
    if (already) return c.json({ error: '오늘 이미 시청한 광고입니다', already: true }, 400);

    // 광고 정보
    const ad = await c.env.DB.prepare('SELECT * FROM tl_ads WHERE id=?').bind(adId).first<any>();
    if (!ad) return c.json({ error: '광고 없음' }, 404);
    if (ad.status !== 'active') return c.json({ error: '비활성 광고' }, 400);
    if (ad.spent_tl >= ad.budget_tl && ad.budget_tl > 0)
      return c.json({ error: '광고 예산 소진' }, 400);

    const reward = ad.tl_reward || 300;

    // TL 지급
    await c.env.DB.prepare('UPDATE users SET tl=tl+? WHERE id=?').bind(reward, userId).run();
    // 광고 통계 업데이트
    await c.env.DB.prepare(
      `UPDATE tl_ads SET views=views+1, completions=completions+1, spent_tl=spent_tl+?, updated_at=datetime('now') WHERE id=?`
    ).bind(reward, adId).run();
    // 시청 로그
    await c.env.DB.prepare(
      `INSERT INTO ad_views (ad_id, user_id, completed, tl_rewarded, duration_watched) VALUES (?,?,1,?,?)`
    ).bind(adId, userId, reward, body.duration || 0).run();

    const user = await c.env.DB.prepare('SELECT tl FROM users WHERE id=?').bind(userId).first<any>();
    return c.json({ ok: true, tl_rewarded: reward, tl_balance: user?.tl || 0 });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 광고 클릭 기록 ──
ads.post('/:id/click', async (c) => {
  try {
    await ensureTables(c.env.DB);
    const adId = c.req.param('id');
    const token = (c.req.header('Authorization') || '').replace('Bearer ', '');
    const userId = parseUserId(token);
    await c.env.DB.prepare('UPDATE tl_ads SET clicks=clicks+1 WHERE id=?').bind(adId).run();
    if (userId) {
      await c.env.DB.prepare(
        `INSERT INTO ad_views (ad_id, user_id, completed, clicked) VALUES (?,?,0,1)
         ON CONFLICT DO UPDATE SET clicked=1`
      ).bind(adId, userId).run().catch(() => {});
    }
    const ad = await c.env.DB.prepare('SELECT target_url FROM tl_ads WHERE id=?').bind(adId).first<any>();
    return c.json({ ok: true, target_url: ad?.target_url || '' });
  } catch (e: any) {
    return c.json({ ok: true });
  }
});

// ── 광고주: 내 광고 목록 ──
ads.get('/my', async (c) => {
  try {
    await ensureTables(c.env.DB);
    const token = (c.req.header('Authorization') || '').replace('Bearer ', '');
    const userId = parseUserId(token);
    if (!userId) return c.json({ error: '로그인 필요' }, 401);

    const result = await c.env.DB.prepare(
      `SELECT * FROM tl_ads WHERE advertiser_id=? ORDER BY created_at DESC`
    ).bind(userId).all();
    return c.json({ ads: result.results || [] });
  } catch (e: any) {
    return c.json({ ads: [], error: e.message });
  }
});

// ── 광고주: 광고 등록 ──
ads.post('/create', async (c) => {
  try {
    await ensureTables(c.env.DB);
    const token = (c.req.header('Authorization') || '').replace('Bearer ', '');
    const userId = parseUserId(token);
    if (!userId) return c.json({ error: '로그인 필요' }, 401);

    // 사업자 확인
    const user = await c.env.DB.prepare(
      'SELECT id, is_business, business_name, tl FROM users WHERE id=?'
    ).bind(userId).first<any>();
    if (!user) return c.json({ error: '유저 없음' }, 404);
    if (!user.is_business) return c.json({ error: '사업자 계정만 광고 등록 가능합니다' }, 403);

    const body = await c.req.json<any>();
    const { title, description, ad_type, media_url, thumbnail_url,
            target_url, tl_reward, budget_tl, daily_limit } = body;

    if (!title) return c.json({ error: 'title 필요' }, 400);
    if (!budget_tl || budget_tl < 1000) return c.json({ error: '최소 예산 1,000 TL' }, 400);
    if ((user.tl || 0) < budget_tl) return c.json({ error: 'TL 잔액 부족' }, 402);

    // 예산 TL 차감 (에스크로)
    await c.env.DB.prepare('UPDATE users SET tl=tl-? WHERE id=?').bind(budget_tl, userId).run();

    const id = 'ad_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    await c.env.DB.prepare(`
      INSERT INTO tl_ads (id, advertiser_id, business_name, title, description,
        ad_type, media_url, thumbnail_url, target_url,
        tl_reward, budget_tl, daily_limit, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active')
    `).bind(
      id, userId, user.business_name || '',
      title, description || '',
      ad_type || 'video', media_url || '', thumbnail_url || '',
      target_url || '',
      Math.min(tl_reward || 300, 1000),
      budget_tl,
      daily_limit || 100
    ).run();

    return c.json({ ok: true, id, budget_tl });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 광고주: 광고 통계 ──
ads.get('/:id/stats', async (c) => {
  try {
    await ensureTables(c.env.DB);
    const adId = c.req.param('id');
    const token = (c.req.header('Authorization') || '').replace('Bearer ', '');
    const userId = parseUserId(token);

    const ad = await c.env.DB.prepare('SELECT * FROM tl_ads WHERE id=? AND advertiser_id=?')
      .bind(adId, userId).first<any>();
    if (!ad) return c.json({ error: '광고 없음 또는 권한 없음' }, 404);

    // 일별 통계 (최근 14일)
    const daily = await c.env.DB.prepare(`
      SELECT DATE(viewed_at) as date,
        COUNT(*) as views,
        SUM(completed) as completions,
        SUM(clicked) as clicks,
        SUM(tl_rewarded) as tl_spent
      FROM ad_views
      WHERE ad_id=? AND viewed_at >= datetime('now', '-14 days')
      GROUP BY DATE(viewed_at)
      ORDER BY date ASC
    `).bind(adId).all();

    // 시간대별 통계 (오늘)
    const hourly = await c.env.DB.prepare(`
      SELECT strftime('%H', viewed_at) as hour, COUNT(*) as views
      FROM ad_views
      WHERE ad_id=? AND DATE(viewed_at)=DATE('now')
      GROUP BY hour ORDER BY hour
    `).bind(adId).all();

    return c.json({
      ad,
      daily: daily.results || [],
      hourly: hourly.results || [],
      ctr: ad.views > 0 ? ((ad.clicks / ad.views) * 100).toFixed(1) : '0.0',
      completion_rate: ad.views > 0 ? ((ad.completions / ad.views) * 100).toFixed(1) : '0.0',
      remaining_budget: Math.max(0, ad.budget_tl - ad.spent_tl),
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ── 광고주: 광고 일시정지/재개 ──
ads.post('/:id/toggle', async (c) => {
  try {
    await ensureTables(c.env.DB);
    const adId = c.req.param('id');
    const token = (c.req.header('Authorization') || '').replace('Bearer ', '');
    const userId = parseUserId(token);
    const ad = await c.env.DB.prepare('SELECT status FROM tl_ads WHERE id=? AND advertiser_id=?')
      .bind(adId, userId).first<any>();
    if (!ad) return c.json({ error: '권한 없음' }, 403);
    const newStatus = ad.status === 'active' ? 'paused' : 'active';
    await c.env.DB.prepare('UPDATE tl_ads SET status=? WHERE id=?').bind(newStatus, adId).run();
    return c.json({ ok: true, status: newStatus });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});


// ── 사이드바 배너 광고 (활성 banner_sidebar 중 랜덤 1개 반환) ──
ads.get('/sidebar', async (c) => {
  try {
    await ensureTables(c.env.DB);

    // 1. banner_sidebar 타입 활성 광고 중 예산 남은 것 랜덤 1개
    const now = new Date().toISOString().slice(0, 10);
    const row = await c.env.DB.prepare(`
      SELECT id, business_name, title, description, thumbnail_url, target_url,
             budget_tl, spent_tl, end_date
      FROM tl_ads
      WHERE ad_type = 'banner_sidebar'
        AND status = 'active'
        AND spent_tl < budget_tl
        AND (end_date = '' OR end_date >= ?)
      ORDER BY RANDOM()
      LIMIT 1
    `).bind(now).first().catch(() => null);

    if (!row) {
      return c.json({ ad: null, message: '활성 사이드바 배너 없음' });
    }

    // 2. 노출(impression) 기록 - spent_tl 차감 (노출당 단가: 7일 50000TL = 1일 약 238 노출당 1TL)
    // 너무 자주 차감되지 않도록 10노출마다 1TL 차감
    const newViews = ((row.views as number) || 0) + 1;
    const costPerImpression = 1; // 1 TL per 1 impression (조정 가능)
    await c.env.DB.prepare(`
      UPDATE tl_ads
      SET views = views + 1,
          spent_tl = spent_tl + ?,
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(costPerImpression, row.id).run().catch(() => {});

    return c.json({
      ad: {
        id: row.id,
        business_name: row.business_name,
        title: row.title,
        description: row.description,
        thumbnail_url: row.thumbnail_url,
        target_url: row.target_url,
      }
    });
  } catch (e: any) {
    return c.json({ ad: null, error: e.message });
  }
});

// ── 사이드바 배너 클릭 기록 (기존 /:id/click 재사용 가능하나 명시적 분리) ──
ads.post('/sidebar/:id/click', async (c) => {
  try {
    const id = c.req.param('id');
    await c.env.DB.prepare(`
      UPDATE tl_ads SET clicks = clicks + 1, updated_at = datetime('now') WHERE id = ?
    `).bind(id).run().catch(() => {});
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message });
  }
});

// ── tl_ads 테이블에 banner 관련 컬럼 마이그레이션 (1회 실행) ──
ads.post('/migrate-banner', async (c) => {
  try {
    await c.env.DB.prepare(
      `ALTER TABLE tl_ads ADD COLUMN target_url TEXT DEFAULT ''`
    ).run().catch(() => {});
    await c.env.DB.prepare(
      `ALTER TABLE tl_ads ADD COLUMN end_date TEXT DEFAULT ''`
    ).run().catch(() => {});
    return c.json({ ok: true, message: 'banner 컬럼 마이그레이션 완료' });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message });
  }
});

export default ads;
