import { Hono } from 'hono';
import type { Env } from './types';

const eco = new Hono<{ Bindings: Env }>();

/* ══════════════════════════════════════════════════════
   TL 3분류 경제 시스템
   ─────────────────────────────────────────────────────
   TL_P (구매): 1원=1TL_P, 현금 교환 가능 (플랜A 5%, B 3% 수수료)
   TL_A (광고): 광고 시청 보상, 플랫폼 내 소비만 가능, 교환 불가
   TL_B (보너스): 가입·이벤트 지급, 플랫폼 내 소비만 가능, 교환 불가

   크리에이터 플랜
   ─────────────────────────────────────────────────────
   플랜 A (기본): TL_P 소비 → 크리에이터 62% / 플랫폼 38%
                  TL_A 소비 → 크리에이터 50% TL_A / 플랫폼 50% TL_A (비교환)
   플랜 B (성장): TL_P 소비 → 크리에이터 45% / 플랫폼 55%
                  TL_A 소비 → 크리에이터 35% TL_A / 플랫폼 65% TL_A (비교환)
                  TLC 채굴 배율 2.0x 보너스

   POC 기여지수 (최소 0.1, 최대 5.0)
   ─────────────────────────────────────────────────────
   창작 기여  40% : TL_P 소비 누적 기반 재생수
   소비 기여  30% : TL_P 월소비량 / 5,000
   청취 기여  20% : 방송 청취 시간 / 30h
   업로드 기여 10% : 신규 업로드 / 5

   TLC 채굴 (TL_P 기반만)
   ─────────────────────────────────────────────────────
   일일 TLC = (TL_P 월소비 / 30) × 0.08 × POC_index
   월 TLC 하드캡 = TL_P 월소비 × 0.30
   플랜 B 배율 2.0x (하드캡은 동일 적용)
══════════════════════════════════════════════════════ */

function parseUserId(token: string | null): string | null {
  if (!token) return null;
  const m = token.match(/^(?:token|fallback)_([^_]+)_/);
  if (m) return m[1];
  if (token.split('.').length === 3) {
    try {
      const p = JSON.parse(atob(token.split('.')[1]));
      return String(p.userId || p.id || p.sub || '');
    } catch { return null; }
  }
  return null;
}

function authId(c: any): string | null {
  return parseUserId((c.req.header('Authorization') || '').replace('Bearer ', '').trim());
}

/* ── DB 마이그레이션: TL 3분류 컬럼 추가 ── */
async function migrateDB(db: any) {
  const alters = [
    `ALTER TABLE users ADD COLUMN tl_p INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN tl_a INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN tl_b INTEGER DEFAULT 10000`,
    `ALTER TABLE users ADD COLUMN tl_p_lifetime INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN tl_p_exchanged INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'A'`,
  ];
  for (const sql of alters) {
    await db.prepare(sql).run().catch(() => {});
  }
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS tl_exchanges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      tl_amount INTEGER NOT NULL,
      fee_pct REAL NOT NULL,
      fee_tl INTEGER NOT NULL,
      net_tl INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run().catch(() => {});
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS tlc_mining_v2 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      tl_p_base INTEGER NOT NULL,
      poc_index REAL NOT NULL,
      plan TEXT NOT NULL,
      multiplier REAL NOT NULL,
      tlc_mined REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run().catch(() => {});
}

/* ══════════════════════════════════════════════════════
   POST /api/eco/migrate
   DB 컬럼 마이그레이션 (최초 1회, admin용)
══════════════════════════════════════════════════════ */
eco.post('/migrate', async (c) => {
  try {
    await migrateDB(c.env.DB);
    // 기존 tl → tl_p 마이그레이션 (기존 유저 구매 TL 보존)
    await c.env.DB.prepare(`
      UPDATE users SET tl_p = tl, tl_p_lifetime = tl
      WHERE tl_p = 0 AND tl > 0
    `).run().catch(() => {});
    return c.json({ ok: true, message: 'TL 3분류 마이그레이션 완료' });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════════
   GET /api/eco/wallet
   유저 지갑 조회 (TL_P / TL_A / TL_B / TLC 분리)
══════════════════════════════════════════════════════ */
eco.get('/wallet', async (c) => {
  const userId = authId(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);
  try {
    await migrateDB(c.env.DB);
    const user = await c.env.DB.prepare(`
      SELECT id, username, tl, tl_p, tl_a, tl_b,
             tl_p_lifetime, tl_p_exchanged,
             tlc_balance, poc_index, plan,
             total_tl_spent, total_tl_earned
      FROM users WHERE id=?
    `).bind(userId).first() as any;
    if (!user) return c.json({ error: '유저 없음' }, 404);

    // 레거시: tl 컬럼이 있으면 tl_p로 사용 (신규 컬럼 없을 시 fallback)
    const tlP = user.tl_p ?? user.tl ?? 0;
    const tlA = user.tl_a ?? 0;
    const tlB = user.tl_b ?? 0;

    return c.json({
      wallet: {
        tl_p: tlP,         // 구매 TL (교환 가능)
        tl_a: tlA,         // 광고 TL (사용만)
        tl_b: tlB,         // 보너스 TL (사용만)
        tl_total: tlP + tlA + tlB,
        tlc: user.tlc_balance || 0,
        poc_index: Number((user.poc_index || 1.0).toFixed(3)),
        plan: user.plan || 'A',
        tl_p_lifetime: user.tl_p_lifetime || 0,
        tl_p_exchanged: user.tl_p_exchanged || 0,
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════════
   POST /api/eco/consume
   콘텐츠 소비 처리 (TL_A 우선 → TL_B → TL_P 순서)
   body: { share_id, seconds, tl_spent, tl_type? }
══════════════════════════════════════════════════════ */
eco.post('/consume', async (c) => {
  const userId = authId(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);

  const body = await c.req.json() as any;
  const { share_id, seconds, tl_spent, tl_type } = body;
  const consume = Math.max(1, Math.floor(tl_spent || seconds || 1));

  try {
    await migrateDB(c.env.DB);

    const user = await c.env.DB.prepare(
      'SELECT tl, tl_p, tl_a, tl_b, plan FROM users WHERE id=?'
    ).bind(userId).first() as any;
    if (!user) return c.json({ error: '유저 없음' }, 404);

    const userPlan = user.plan || 'A';
    const tlP = user.tl_p ?? user.tl ?? 0;
    const tlA = user.tl_a ?? 0;
    const tlB = user.tl_b ?? 0;

    // 소비 우선순위: TL_A → TL_B → TL_P
    let remainConsume = consume;
    let consumedA = 0, consumedB = 0, consumedP = 0;

    if (tlA > 0 && remainConsume > 0) {
      consumedA = Math.min(tlA, remainConsume);
      remainConsume -= consumedA;
    }
    if (tlB > 0 && remainConsume > 0) {
      consumedB = Math.min(tlB, remainConsume);
      remainConsume -= consumedB;
    }
    if (tlP > 0 && remainConsume > 0) {
      consumedP = Math.min(tlP, remainConsume);
      remainConsume -= consumedP;
    }

    const actualConsumed = consumedA + consumedB + consumedP;
    if (actualConsumed <= 0) return c.json({ error: 'TL 잔액 부족', insufficient: true }, 402);

    // TL 차감
    await c.env.DB.prepare(`
      UPDATE users SET
        tl_p = MAX(0, tl_p - ?),
        tl_a = MAX(0, tl_a - ?),
        tl_b = MAX(0, tl_b - ?),
        tl = MAX(0, tl - ?),
        total_tl_spent = total_tl_spent + ?
      WHERE id=?
    `).bind(consumedP, consumedA, consumedB, consumedP, consumedP, userId).run();

    // 크리에이터 수익 배분
    let creatorEarnP = 0, creatorEarnA = 0;
    let platformEarnP = 0, platformEarnA = 0;

    const share = await c.env.DB.prepare(
      'SELECT user_id as creator_id, plan FROM tl_shares WHERE id=?'
    ).bind(share_id).first() as any;

    if (share) {
      // TL_P 소비 → 크리에이터에게 TL_P (교환 가능)
      const rateP = userPlan === 'B' ? 0.45 : 0.62;
      creatorEarnP = Math.floor(consumedP * rateP);
      platformEarnP = consumedP - creatorEarnP;

      // TL_A 소비 → 크리에이터에게 TL_A (비교환)
      const rateA = userPlan === 'B' ? 0.35 : 0.50;
      creatorEarnA = Math.floor(consumedA * rateA);
      platformEarnA = consumedA - creatorEarnA;

      // TL_B 소비 → 플랫폼 수익 (크리에이터 분배 없음, 보너스는 원가 없음)
      // → 크리에이터에게 TL_B의 30%만 TL_A로 지급
      const creatorEarnFromB = Math.floor(consumedB * 0.30);

      if (creatorEarnP > 0 || creatorEarnA > 0 || creatorEarnFromB > 0) {
        await c.env.DB.prepare(`
          UPDATE users SET
            tl_p = tl_p + ?,
            tl = tl + ?,
            tl_a = tl_a + ?,
            total_tl_earned = total_tl_earned + ?
          WHERE id=?
        `).bind(
          creatorEarnP, creatorEarnP,
          creatorEarnA + creatorEarnFromB,
          creatorEarnP,
          share.creator_id
        ).run();
      }

      // pulse 증가 (TL_P 소비 시만)
      if (consumedP > 0) {
        await c.env.DB.prepare(
          'UPDATE tl_shares SET pulse=pulse+1 WHERE id=?'
        ).bind(share_id).run();
      }
    }

    // tl_user_files 차감
    if (share_id) {
      await c.env.DB.prepare(`
        UPDATE tl_user_files SET
          tl_balance = MAX(0, tl_balance - ?),
          total_consumed = total_consumed + ?,
          last_played = datetime('now'),
          updated_at = datetime('now')
        WHERE user_id=? AND share_id=?
      `).bind(actualConsumed, actualConsumed, userId, share_id).run();
    }

    // POC 업데이트 (TL_P 기반만 주요 기여, TL_A/B는 5%)
    if (seconds > 0) {
      const pocGained = consumedP * 0.01 + (consumedA + consumedB) * 0.0005;
      await c.env.DB.prepare(`
        INSERT INTO poc_logs (user_id, mode, seconds, tl_spent, poc_gained)
        VALUES (?, 'consume', ?, ?, ?)
      `).bind(userId, seconds, consumedP, pocGained).run().catch(() => {});
    }

    const updated = await c.env.DB.prepare(
      'SELECT tl, tl_p, tl_a, tl_b FROM users WHERE id=?'
    ).bind(userId).first() as any;

    return c.json({
      ok: true,
      consumed: { tl_p: consumedP, tl_a: consumedA, tl_b: consumedB, total: actualConsumed },
      creator: { tl_p: creatorEarnP, tl_a: creatorEarnA },
      wallet: {
        tl_p: updated?.tl_p ?? updated?.tl ?? 0,
        tl_a: updated?.tl_a ?? 0,
        tl_b: updated?.tl_b ?? 0,
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════════
   POST /api/eco/ad-reward
   광고 시청 완료 → TL_A 지급 (교환 불가)
   body: { ad_id, tl_amount }
══════════════════════════════════════════════════════ */
eco.post('/ad-reward', async (c) => {
  const userId = authId(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);

  const { tl_amount, ad_id } = await c.req.json() as any;
  const reward = Math.min(Math.max(50, tl_amount || 300), 1000);

  try {
    await migrateDB(c.env.DB);

    // 오늘 이미 해당 광고 시청했는지 체크
    const already = await c.env.DB.prepare(
      `SELECT id FROM ad_views WHERE ad_id=? AND user_id=? AND DATE(viewed_at)=DATE('now') AND completed=1`
    ).bind(ad_id || 'general', userId).first().catch(() => null);
    if (already) return c.json({ error: '오늘 이미 시청한 광고', already: true }, 400);

    // TL_A 지급 (교환 불가)
    await c.env.DB.prepare(
      'UPDATE users SET tl_a = tl_a + ? WHERE id=?'
    ).bind(reward, userId).run();

    const user = await c.env.DB.prepare(
      'SELECT tl_p, tl_a, tl_b FROM users WHERE id=?'
    ).bind(userId).first() as any;

    return c.json({
      ok: true,
      tl_a_rewarded: reward,
      wallet: {
        tl_p: user?.tl_p ?? 0,
        tl_a: user?.tl_a ?? 0,
        tl_b: user?.tl_b ?? 0,
      },
      note: 'TL_A는 플랫폼 내 소비만 가능합니다'
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════════
   POST /api/eco/exchange
   TL_P → 현금 교환 신청 (수수료 차감 후 순액 지급)
   body: { tl_amount }
══════════════════════════════════════════════════════ */
eco.post('/exchange', async (c) => {
  const userId = authId(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);

  const { tl_amount } = await c.req.json() as any;
  if (!tl_amount || tl_amount < 1000) return c.json({ error: '최소 교환 금액: 1,000 TL' }, 400);

  try {
    await migrateDB(c.env.DB);

    const user = await c.env.DB.prepare(
      'SELECT tl_p, tl, plan FROM users WHERE id=?'
    ).bind(userId).first() as any;
    if (!user) return c.json({ error: '유저 없음' }, 404);

    const tlP = user.tl_p ?? user.tl ?? 0;
    if (tlP < tl_amount) return c.json({ error: 'TL_P 잔액 부족', balance: tlP }, 402);

    // 수수료: 플랜A 5%, 플랜B 3%
    const feePct = (user.plan || 'A') === 'B' ? 0.03 : 0.05;
    const feeTL = Math.ceil(tl_amount * feePct);
    const netTL = tl_amount - feeTL;

    // TL_P 차감
    await c.env.DB.prepare(`
      UPDATE users SET
        tl_p = tl_p - ?,
        tl = MAX(0, tl - ?),
        tl_p_exchanged = tl_p_exchanged + ?
      WHERE id=?
    `).bind(tl_amount, tl_amount, tl_amount, userId).run();

    // 교환 내역 기록
    await c.env.DB.prepare(`
      INSERT INTO tl_exchanges (user_id, tl_amount, fee_pct, fee_tl, net_tl, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).bind(userId, tl_amount, feePct, feeTL, netTL).run();

    return c.json({
      ok: true,
      tl_requested: tl_amount,
      fee_pct: feePct * 100,
      fee_tl: feeTL,
      net_tl: netTL,
      note: `${(feePct*100).toFixed(0)}% 수수료 차감 후 ${netTL.toLocaleString()}원 지급 예정`
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════════
   POST /api/eco/activity
   활동 보고 + POC 재계산 (신 알고리즘)
   body: { seconds, tl_p_spent, tl_a_spent, tl_b_spent,
           mode, share_id, new_uploads, listen_minutes }
══════════════════════════════════════════════════════ */
eco.post('/activity', async (c) => {
  const userId = authId(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);

  const body = await c.req.json() as any;
  const {
    seconds = 0,
    tl_p_spent = 0,
    tl_a_spent = 0,
    tl_b_spent = 0,
    mode = 'listen',
    share_id,
    new_uploads = 0,
    listen_minutes = 0,
  } = body;

  try {
    await migrateDB(c.env.DB);

    // POC 로그 기록
    if (seconds > 0 || tl_p_spent > 0 || tl_a_spent > 0 || new_uploads > 0) {
      await c.env.DB.prepare(`
        INSERT INTO poc_logs (user_id, mode, seconds, tl_spent, poc_gained)
        VALUES (?, ?, ?, ?, 0)
      `).bind(userId, mode, seconds, tl_p_spent).run().catch(() => {});
    }

    // 월간 집계 데이터 조회 (POC 계산용)
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

    const monthlyStats = await c.env.DB.prepare(`
      SELECT
        SUM(CASE WHEN mode='consume' THEN tl_spent ELSE 0 END) as monthly_tl_p,
        SUM(seconds) as total_seconds
      FROM poc_logs
      WHERE user_id=? AND created_at >= ?
    `).bind(userId, monthStart).first() as any;

    const shareStats = await c.env.DB.prepare(`
      SELECT COUNT(*) as play_count
      FROM poc_logs
      WHERE user_id=? AND mode='listen' AND created_at >= ?
    `).bind(userId, monthStart).first() as any;

    const uploadStats = await c.env.DB.prepare(`
      SELECT COUNT(*) as upload_count
      FROM tl_shares
      WHERE user_id=? AND created_at >= ?
    `).bind(userId, monthStart + ' 00:00:00').first().catch(() => ({ upload_count: 0 })) as any;

    // ── POC 신 알고리즘 ──
    // 요소별 정규화 (각 최대값 기준)
    const monthlyTlP   = Number(monthlyStats?.monthly_tl_p || 0) + tl_p_spent;
    const monthlyPlays = Number(shareStats?.play_count || 0);
    const monthlyHours = (Number(monthlyStats?.total_seconds || 0) + seconds) / 3600;
    const uploads      = Number(uploadStats?.upload_count || 0) + new_uploads;

    // 각 요소 점수 (0 ~ 최대값)
    const contentScore = Math.min(2.0, monthlyPlays / 500);        // 500회 = 만점
    const spendScore   = Math.min(1.5, monthlyTlP / 5000);         // 5,000 TL_P = 만점
    const listenScore  = Math.min(1.0, monthlyHours / 30);         // 30시간 = 만점
    const uploadScore  = Math.min(0.5, uploads / 5);               // 5개 = 만점

    // 가중합 (총 최대 5.0)
    const rawPoc = contentScore * 0.4 + spendScore * 0.3 +
                   listenScore  * 0.2 + uploadScore * 0.1;

    // 하드캡 5.0, 최솟값 0.1
    const pocIndex = Math.min(5.0, Math.max(0.1, rawPoc * 10));

    await c.env.DB.prepare(
      'UPDATE users SET poc_index=? WHERE id=?'
    ).bind(pocIndex, userId).run();

    // ── TLC 채굴 가능량 계산 ──
    const user = await c.env.DB.prepare(
      'SELECT plan, tl_p_lifetime, tl_p_exchanged FROM users WHERE id=?'
    ).bind(userId).first() as any;

    const userPlan      = user?.plan || 'A';
    const mineMultiplier = userPlan === 'B' ? 2.0 : 1.0;

    // 일일 채굴량 = (월소비 / 30) × 0.08 × POC × 배율
    const dailyBase = (monthlyTlP / 30) * 0.08;
    const dailyTLC  = dailyBase * pocIndex * mineMultiplier;

    // 월 하드캡: TL_P 월소비의 30%
    const monthHardCap = monthlyTlP * 0.30;

    return c.json({
      ok: true,
      poc_index: Number(pocIndex.toFixed(3)),
      poc_components: {
        content: Number(contentScore.toFixed(3)),
        spend:   Number(spendScore.toFixed(3)),
        listen:  Number(listenScore.toFixed(3)),
        upload:  Number(uploadScore.toFixed(3)),
      },
      tlc_mining: {
        daily_max: Number(dailyTLC.toFixed(2)),
        monthly_hard_cap: Number(monthHardCap.toFixed(0)),
        plan_multiplier: mineMultiplier,
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════════
   POST /api/eco/mine-tlc
   TLC 채굴 확정 (하루 1회, 하드캡 적용)
══════════════════════════════════════════════════════ */
eco.post('/mine-tlc', async (c) => {
  const userId = authId(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);

  const { tlc_amount } = await c.req.json() as any;
  if (!tlc_amount || tlc_amount <= 0) return c.json({ error: '채굴량 없음' }, 400);

  try {
    await migrateDB(c.env.DB);

    // 오늘 채굴 내역 확인
    const today = new Date().toISOString().slice(0, 10);
    const already = await c.env.DB.prepare(`
      SELECT COALESCE(SUM(tlc_mined), 0) as mined
      FROM tlc_mining_v2
      WHERE user_id=? AND DATE(created_at)=?
    `).bind(userId, today).first() as any;
    const todayMined = Number(already?.mined || 0);

    // 유저 데이터
    const user = await c.env.DB.prepare(`
      SELECT tl_p, tl, tl_p_lifetime, tl_p_exchanged, poc_index, plan, tlc_balance
      FROM users WHERE id=?
    `).bind(userId).first() as any;
    if (!user) return c.json({ error: '유저 없음' }, 404);

    const pocIndex      = Number(user.poc_index || 1.0);
    const userPlan      = user.plan || 'A';
    const mineMultiplier = userPlan === 'B' ? 2.0 : 1.0;

    // 이번 달 TL_P 소비 조회
    const monthStart = new Date().toISOString().slice(0, 7) + '-01';
    const monthStats = await c.env.DB.prepare(`
      SELECT COALESCE(SUM(tl_spent), 0) as monthly_tl_p
      FROM poc_logs WHERE user_id=? AND mode='consume' AND created_at >= ?
    `).bind(userId, monthStart).first() as any;

    const monthlyTlP = Number(monthStats?.monthly_tl_p || 0);

    // 일일 최대 채굴량
    const dailyMax = (monthlyTlP / 30) * 0.08 * pocIndex * mineMultiplier;
    // 월 하드캡 (일 환산)
    const monthHardCapDaily = (monthlyTlP * 0.30) / 30;
    const actualDailyMax = Math.min(dailyMax, monthHardCapDaily);

    // 오늘 남은 채굴량
    const remainToday = Math.max(0, actualDailyMax - todayMined);
    const actualMine = Math.min(tlc_amount, remainToday);

    if (actualMine <= 0.01) {
      return c.json({
        error: '오늘 채굴 한도 초과 또는 TL_P 소비 실적 없음',
        today_mined: todayMined,
        daily_max: actualDailyMax
      }, 400);
    }

    // TLC 지급
    await c.env.DB.prepare(
      'UPDATE users SET tlc_balance = tlc_balance + ? WHERE id=?'
    ).bind(actualMine, userId).run();

    await c.env.DB.prepare(`
      INSERT INTO tlc_mining_v2 (user_id, tl_p_base, poc_index, plan, multiplier, tlc_mined)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(userId, monthlyTlP, pocIndex, userPlan, mineMultiplier, actualMine).run();

    const updated = await c.env.DB.prepare(
      'SELECT tlc_balance FROM users WHERE id=?'
    ).bind(userId).first() as any;

    return c.json({
      ok: true,
      mined: Number(actualMine.toFixed(4)),
      tlc_total: updated?.tlc_balance || 0,
      today_total: todayMined + actualMine,
      daily_max: Number(actualDailyMax.toFixed(4)),
      poc_index: pocIndex,
      plan_multiplier: mineMultiplier
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════════
   POST /api/eco/set-plan
   크리에이터 플랜 변경 (A ↔ B)
══════════════════════════════════════════════════════ */
eco.post('/set-plan', async (c) => {
  const userId = authId(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);

  const { plan } = await c.req.json() as any;
  if (!['A', 'B'].includes(plan)) return c.json({ error: '플랜은 A 또는 B' }, 400);

  try {
    await migrateDB(c.env.DB);
    await c.env.DB.prepare('UPDATE users SET plan=? WHERE id=?').bind(plan, userId).run();
    return c.json({
      ok: true, plan,
      note: plan === 'A'
        ? '플랜A: TL_P 62% 수취, 교환수수료 5%'
        : '플랜B: TL_P 45% 수취, TLC 2배 채굴, 교환수수료 3%'
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════════
   POST /api/payment/portone/verify (오버라이드)
   결제 완료 → TL_P 지급 (구매 TL, 교환 가능)
══════════════════════════════════════════════════════ */
eco.post('/purchase', async (c) => {
  const userId = authId(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);

  const { amount_krw } = await c.req.json() as any;
  if (!amount_krw || amount_krw < 100) return c.json({ error: '최소 100원' }, 400);

  try {
    await migrateDB(c.env.DB);
    // 1원 = 1 TL_P
    await c.env.DB.prepare(`
      UPDATE users SET
        tl_p = tl_p + ?,
        tl = tl + ?,
        tl_p_lifetime = tl_p_lifetime + ?
      WHERE id=?
    `).bind(amount_krw, amount_krw, amount_krw, userId).run();

    const user = await c.env.DB.prepare(
      'SELECT tl_p, tl_a, tl_b, tl FROM users WHERE id=?'
    ).bind(userId).first() as any;

    return c.json({
      ok: true,
      tl_p_granted: amount_krw,
      wallet: {
        tl_p: user?.tl_p ?? user?.tl ?? 0,
        tl_a: user?.tl_a ?? 0,
        tl_b: user?.tl_b ?? 0,
      }
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════════
   GET /api/eco/summary
   플랫폼 수익 요약 (admin용)
══════════════════════════════════════════════════════ */
eco.get('/summary', async (c) => {
  try {
    await migrateDB(c.env.DB);
    const stats = await c.env.DB.prepare(`
      SELECT
        COUNT(*) as total_users,
        SUM(tl_p) as total_tl_p,
        SUM(tl_a) as total_tl_a,
        SUM(tl_b) as total_tl_b,
        SUM(tl_p_lifetime) as total_purchased,
        SUM(tl_p_exchanged) as total_exchanged,
        AVG(poc_index) as avg_poc,
        SUM(tlc_balance) as total_tlc
      FROM users
    `).first() as any;

    const exchangeStats = await c.env.DB.prepare(`
      SELECT
        SUM(tl_amount) as total_exchange_requests,
        SUM(fee_tl) as total_fees_collected,
        COUNT(*) as exchange_count
      FROM tl_exchanges WHERE status='pending'
    `).first() as any;

    return c.json({ stats, exchangeStats });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

export default eco;
