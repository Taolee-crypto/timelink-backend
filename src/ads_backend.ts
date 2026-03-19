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
    tl_key TEXT DEFAULT '',       -- R2 .tl 파일 키
    tl_file_size INTEGER DEFAULT 0,
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
    tl_key TEXT DEFAULT '',
    tl_file_size INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run().catch(() => {});

  await db.prepare("ALTER TABLE tl_ads ADD COLUMN tl_key TEXT DEFAULT ''").run().catch(()=>{});
  await db.prepare("ALTER TABLE tl_ads ADD COLUMN tl_file_size INTEGER DEFAULT 0").run().catch(()=>{});
  await db.prepare("ALTER TABLE tl_ads ADD COLUMN tl_per_sec REAL DEFAULT 1.0").run().catch(()=>{});
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


// ── .tl 파일 변환 헬퍼 ──────────────────────────────────
function makeTLKeyForAd(shareId: string, secret: string): Uint8Array {
  const seed = shareId + secret + 'TIMELINK_AD_v1';
  const key = new Uint8Array(256);
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = (Math.imul(h, 0x01000193)) >>> 0;
  }
  for (let i = 0; i < 256; i++) {
    h ^= (Math.imul(i, 0x9e3779b9)) >>> 0;
    h = ((h << 13) | (h >>> 19)) >>> 0;
    h = (Math.imul(h, 0x01000193)) >>> 0;
    key[i] = h & 0xff;
  }
  return key;
}

function xorAdData(data: Uint8Array, key: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i % key.length];
  return out;
}

async function sha256HexAd(data: Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

async function buildAdTLFile(adId: string, header: Record<string,any>, rawData: Uint8Array, secret: string): Promise<Uint8Array> {
  const magic   = new Uint8Array([0x54,0x4C,0x41,0x44]); // TLAD
  const version = new Uint8Array([0x00,0x01]);
  const hdrBytes = new TextEncoder().encode(JSON.stringify(header));
  const hdrLen   = hdrBytes.length;
  const lenB     = new Uint8Array([hdrLen&0xff,(hdrLen>>8)&0xff,(hdrLen>>16)&0xff,(hdrLen>>24)&0xff]);
  const key      = makeTLKeyForAd(adId, secret);
  const enc      = xorAdData(rawData, key);
  const out      = new Uint8Array(4+2+4+hdrLen+enc.length);
  let p=0; out.set(magic,p);p+=4; out.set(version,p);p+=2; out.set(lenB,p);p+=4;
  out.set(hdrBytes,p);p+=hdrLen; out.set(enc,p);
  return out;
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

// ── 광고 소재 업로드 + .tl 변환 ──
// POST /api/ads/upload-tl
// FormData: file, adId(임시ID)
ads.post('/upload-tl', async (c) => {
  if (!c.env.R2) return c.json({ ok:false, error:'R2 없음' }, 500);
  const token = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId = parseUserId(token);
  if (!userId) return c.json({ error:'로그인 필요' }, 401);

  try {
    const formData = await c.req.parseBody({ limit: 100*1024*1024 }); // 광고 100MB
    const file  = formData['file'] as File;
    const adId  = formData['adId'] as string || ('ad_' + Date.now() + '_' + Math.random().toString(36).slice(2,6));
    const title = formData['title'] as string || '';
    const adType = formData['ad_type'] as string || 'video';
    const tlPerSec = parseFloat(formData['tl_per_sec'] as string || '1.0');

    if (!file) return c.json({ ok:false, error:'file 필요' }, 400);
    if (file.size > 100*1024*1024) return c.json({ ok:false, error:'100MB 초과 불가' }, 400);

    const raw    = new Uint8Array(await file.arrayBuffer());
    const hash   = await sha256HexAd(raw);
    const ext    = (file.name.split('.').pop() || 'bin').toLowerCase();
    const secret = (c.env as any).TL_SECRET || 'timelink_default_secret_2026';

    const header = {
      adId,
      advertiserId: userId,
      title,
      adType,         // 'video' | 'audio' | 'image' | 'banner_sidebar'
      fileType: file.type || 'application/octet-stream',
      ext,
      tl_per_sec: tlPerSec,
      uploadedAt: new Date().toISOString(),
      contentHash: hash,
      platform: 'timelink.digital',
      version: 1,
      isAd: true,     // 광고 파일 식별자
    };

    const tlData = await buildAdTLFile(adId, header, raw, secret);
    const key    = `ads/${adId}.tl`;

    await c.env.R2.put(key, tlData, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { adId, title, ext, adType, isAd: 'true' },
    });

    return c.json({ ok:true, adId, key, tl_key: key, size: tlData.length, hash });
  } catch(e:any) {
    return c.json({ ok:false, error: e.message }, 500);
  }
});

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

    const id = body.adId || ('ad_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
    const tl_key = body.tl_key || '';
    const tl_file_size = body.tl_file_size || 0;
    const tl_per_sec = Math.max(0.1, Math.min(10.0, parseFloat(body.tl_per_sec || '1.0')));
    await c.env.DB.prepare(`
      INSERT INTO tl_ads (id, advertiser_id, business_name, title, description,
        ad_type, media_url, thumbnail_url, target_url,
        tl_reward, budget_tl, daily_limit, status, tl_key, tl_file_size)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?)
    `).bind(
      id, userId, user.business_name || '',
      title, description || '',
      ad_type || 'video', media_url || '', thumbnail_url || '',
      target_url || '',
      Math.min(tl_reward || 300, 1000),
      budget_tl,
      daily_limit || 100,
      tl_key,
      tl_file_size
    ).run();

    return c.json({ ok: true, id, budget_tl });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});


// ── 광고 .tl 스트리밍 (TL 차감 구조) ──
// GET /api/ads/stream/:adId
// - 광고주 예산에서 TL 차감 (초당)
// - 뷰어에게 TL_A 적립
ads.get('/stream/:adId', async (c) => {
  const adId   = c.req.param('adId');
  const token  = (c.req.header('Authorization')||'').replace('Bearer ','');
  const tkQuery = c.req.query('tk') || '';
  const userId = parseUserId(token || tkQuery);

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Range,Content-Type,Authorization',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  try {
    await ensureTables(c.env.DB);
    const ad = await c.env.DB.prepare(
      'SELECT * FROM tl_ads WHERE id=? AND status=\'active\''
    ).bind(adId).first<any>();
    if (!ad) return new Response(JSON.stringify({error:'광고 없음'}),{status:404,headers:cors});

    // 예산 소진 확인
    if (ad.budget_tl > 0 && ad.spent_tl >= ad.budget_tl) {
      // 예산 소진 → 자동 종료
      await c.env.DB.prepare("UPDATE tl_ads SET status='ended' WHERE id=?").bind(adId).run();
      return new Response(JSON.stringify({error:'광고 예산 소진',code:'BUDGET_EXHAUSTED'}),{status:402,headers:cors});
    }

    // .tl 파일 R2에서 조회
    const tlKey = ad.tl_key || `ads/${adId}.tl`;
    const obj   = await c.env.R2.get(tlKey);
    if (!obj) return new Response(JSON.stringify({error:'.tl 파일 없음'}),{status:404,headers:cors});

    const secret = (c.env as any).TL_SECRET || 'timelink_default_secret_2026';

    // .tl 복호화
    const tlData   = new Uint8Array(await obj.arrayBuffer());
    if (tlData[0]!==0x54||tlData[1]!==0x4C||tlData[2]!==0x41||tlData[3]!==0x44) {
      // 매직 불일치 → 원본 그대로 반환 (미변환 파일)
      return new Response(obj.body, {
        headers:{...cors,'Content-Type': ad.ad_type?.startsWith('video')?'video/mp4':'audio/mpeg'}
      });
    }
    const hdrLen  = tlData[6]|(tlData[7]<<8)|(tlData[8]<<16)|(tlData[9]<<24);
    const hdrBytes = tlData.slice(10, 10+hdrLen);
    const header   = JSON.parse(new TextDecoder().decode(hdrBytes)) as Record<string,any>;
    const encData  = tlData.slice(10+hdrLen);
    const key      = makeTLKeyForAd(adId, secret);
    const rawData  = xorAdData(encData, key);
    const contentType = (header.fileType as string) || 'video/mp4';

    // 노출 카운트
    await c.env.DB.prepare(
      'UPDATE tl_ads SET views=views+1, updated_at=datetime(\'now\') WHERE id=?'
    ).bind(adId).run().catch(()=>{});

    return new Response(rawData, {
      headers:{...cors,
        'Content-Type': contentType,
        'Content-Length': String(rawData.length),
        'X-Ad-Id': adId,
        'X-TL-Per-Sec': String(ad.tl_per_sec || 1.0),
      }
    });
  } catch(e:any) {
    return new Response(JSON.stringify({error:e.message}),{status:500,headers:cors});
  }
});

// ── 광고 시청 tick (초당 예산 차감 + 뷰어 TL_A 적립) ──
// POST /api/ads/stream/:adId/tick
ads.post('/stream/:adId/tick', async (c) => {
  const adId  = c.req.param('adId');
  const token = (c.req.header('Authorization')||'').replace('Bearer ','');
  const userId = parseUserId(token);
  if (!userId) return c.json({error:'로그인 필요'},401);

  try {
    await ensureTables(c.env.DB);
    const body = await c.req.json<any>();
    const seconds    = Math.min(Number(body.seconds||1), 10);
    const completed  = body.completed === true;

    const ad = await c.env.DB.prepare(
      'SELECT * FROM tl_ads WHERE id=? AND status=\'active\''
    ).bind(adId).first<any>();
    if (!ad) return c.json({error:'광고 없음'},404);

    const tlPerSec  = Number(ad.tl_per_sec || 1.0);
    const cost      = Math.ceil(seconds * tlPerSec);  // 광고주 예산 차감
    const reward    = Math.floor(cost * 0.5);          // 뷰어 50% 적립 (TL_A)

    // 예산 잔액 확인
    if (ad.budget_tl > 0 && (ad.spent_tl + cost) > ad.budget_tl) {
      await c.env.DB.prepare("UPDATE tl_ads SET status='ended' WHERE id=?").bind(adId).run();
      return c.json({ok:false, code:'BUDGET_EXHAUSTED'}, 402);
    }

    // 광고주 예산 차감
    await c.env.DB.prepare(
      'UPDATE tl_ads SET spent_tl=spent_tl+?, updated_at=datetime(\'now\') WHERE id=?'
    ).bind(cost, adId).run();

    // 뷰어 TL_A 적립
    if (reward > 0) {
      await c.env.DB.prepare(
        'UPDATE users SET tl_a=COALESCE(tl_a,0)+?, tl=COALESCE(tl,0)+? WHERE id=?'
      ).bind(reward, reward, userId).run();
    }

    // 완료 시 완료 카운트
    if (completed) {
      await c.env.DB.prepare(
        'UPDATE tl_ads SET completions=completions+1 WHERE id=?'
      ).bind(adId).run().catch(()=>{});
    }

    // 뷰어 현재 잔액 조회
    const user = await c.env.DB.prepare(
      'SELECT COALESCE(tl,0) as tl, COALESCE(tl_a,0) as tl_a FROM users WHERE id=?'
    ).bind(userId).first<any>();

    return c.json({
      ok: true,
      cost,
      reward,
      budget_remaining: Math.max(0, ad.budget_tl - ad.spent_tl - cost),
      viewer_tl: user?.tl || 0,
      viewer_tl_a: user?.tl_a || 0,
    });
  } catch(e:any) {
    return c.json({ok:false, error:e.message}, 500);
  }
});

ads.options('/stream/:adId', async (c) => new Response(null,{status:204,headers:{
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Methods':'GET,OPTIONS',
  'Access-Control-Allow-Headers':'Range,Content-Type,Authorization',
}}));

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
