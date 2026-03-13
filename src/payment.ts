import { Hono } from 'hono';
import type { Env } from './types';

const payment = new Hono<{ Bindings: Env }>();

/* ──────────────────────────────────────────────────
   공통 유틸: 토큰 파싱 → user_id
────────────────────────────────────────────────── */
function parseUserId(token: string | null): string | null {
  if (!token) return null;
  // token_{userId}_{ts} | fallback_{userId}_{ts} | demo_{ts}
  const m = token.match(/^(?:token|fallback)_([^_]+)_/);
  return m ? m[1] : null;
}

function authUserId(c: any): string | null {
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  return parseUserId(token);
}

/* ──────────────────────────────────────────────────
   결제 내역 테이블 생성 (첫 요청 시 자동)
   CREATE TABLE tl_payments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL,
     method TEXT NOT NULL,          -- portone | stripe
     pg_id TEXT NOT NULL UNIQUE,    -- imp_uid | payment_intent_id
     merchant_uid TEXT,
     amount_krw INTEGER NOT NULL,   -- 실제 결제 금액 (원)
     tl_granted INTEGER NOT NULL,   -- 지급된 TL
     status TEXT DEFAULT 'pending', -- pending | success | fail
     created_at TEXT DEFAULT (datetime('now'))
   );
────────────────────────────────────────────────── */
async function ensurePaymentTable(db: any) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS tl_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      method TEXT NOT NULL,
      pg_id TEXT NOT NULL UNIQUE,
      merchant_uid TEXT,
      amount_krw INTEGER NOT NULL,
      tl_granted INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
}

/* ══════════════════════════════════════════════════
   포트원(아임포트) 결제 검증 + TL 지급
   POST /api/payment/portone/verify
   body: { imp_uid, merchant_uid, amount, user_id? }
══════════════════════════════════════════════════ */
payment.post('/portone/verify', async (c) => {
  const userId = authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  const { imp_uid, merchant_uid, amount } = await c.req.json() as any;
  if (!imp_uid || !amount || amount <= 0) {
    return c.json({ error: '잘못된 결제 요청입니다' }, 400);
  }

  await ensurePaymentTable(c.env.DB);

  // 중복 결제 방지
  const dup = await c.env.DB.prepare('SELECT id FROM tl_payments WHERE pg_id=?').bind(imp_uid).first();
  if (dup) return c.json({ error: '이미 처리된 결제입니다' }, 409);

  // ── 포트원 액세스 토큰 발급 ──
  const IMP_KEY    = (c.env as any).PORTONE_IMP_KEY    || 'imp00000000';   // 테스트키
  const IMP_SECRET = (c.env as any).PORTONE_IMP_SECRET || 'test_secret';  // 테스트 시크릿

  let verified = false;
  let paidAmount = 0;

  try {
    // 1) 액세스 토큰
    const tokenRes = await fetch('https://api.iamport.kr/users/getToken', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imp_key: IMP_KEY, imp_secret: IMP_SECRET }),
    });
    const tokenData: any = await tokenRes.json();
    const accessToken = tokenData?.response?.access_token;

    if (accessToken) {
      // 2) 결제 정보 조회
      const payRes = await fetch(`https://api.iamport.kr/payments/${imp_uid}`, {
        headers: { Authorization: accessToken },
      });
      const payData: any = await payRes.json();
      const payment = payData?.response;

      if (payment && payment.status === 'paid') {
        paidAmount = payment.amount;
        // 금액 위변조 검증
        if (paidAmount === Number(amount)) {
          verified = true;
        }
      }
    }
  } catch (_e) {
    // 테스트 모드: 포트원 API 실패 시 amount 그대로 신뢰 (테스트 전용)
    if (IMP_KEY === 'imp00000000') {
      verified = true;
      paidAmount = Number(amount);
    }
  }

  if (!verified) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO tl_payments (user_id,method,pg_id,merchant_uid,amount_krw,tl_granted,status)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(userId, 'portone', imp_uid, merchant_uid || '', amount, 0, 'fail').run();
    return c.json({ error: '결제 검증 실패' }, 400);
  }

  // TL 지급 (1원 = 1TL)
  const tlGranted = paidAmount;

  try {
    await c.env.DB.prepare('UPDATE users SET tl=tl+? WHERE id=?').bind(tlGranted, userId).run();
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO tl_payments (user_id,method,pg_id,merchant_uid,amount_krw,tl_granted,status)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(userId, 'portone', imp_uid, merchant_uid || '', paidAmount, tlGranted, 'success').run();

    const user = await c.env.DB.prepare('SELECT tl, tlc_balance, poc_index FROM users WHERE id=?').bind(userId).first() as any;
    return c.json({ success: true, tl_granted: tlGranted, tl_balance: user?.tl || 0 });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════
   Stripe: PaymentIntent 생성
   POST /api/payment/stripe/intent
   body: { amount_krw }   (1원 단위)
══════════════════════════════════════════════════ */
payment.post('/stripe/intent', async (c) => {
  const userId = authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  const { amount_krw } = await c.req.json() as any;
  if (!amount_krw || amount_krw < 100) {
    return c.json({ error: '최소 결제 금액은 100원입니다' }, 400);
  }

  const STRIPE_SECRET = (c.env as any).STRIPE_SECRET_KEY || 'sk_test_placeholder';

  try {
    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(STRIPE_SECRET + ':'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        amount: String(amount_krw),   // KRW는 최소 단위가 1원
        currency: 'krw',
        'metadata[user_id]': userId,
        'metadata[tl_amount]': String(amount_krw),
        automatic_payment_methods: 'false',
        'payment_method_types[]': 'card',
      }),
    });
    const data: any = await res.json();

    if (data.error) {
      // 테스트 키 미설정 시 mock client_secret 반환 (UI 개발용)
      if (STRIPE_SECRET === 'sk_test_placeholder') {
        return c.json({
          client_secret: 'pi_test_mock_secret_for_development',
          payment_intent_id: 'pi_test_mock_' + Date.now(),
          amount: amount_krw,
          test_mode: true,
        });
      }
      return c.json({ error: data.error.message }, 400);
    }

    return c.json({
      client_secret: data.client_secret,
      payment_intent_id: data.id,
      amount: amount_krw,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════
   Stripe: 결제 확인 후 TL 지급
   POST /api/payment/stripe/confirm
   body: { payment_intent_id, amount_krw }
══════════════════════════════════════════════════ */
payment.post('/stripe/confirm', async (c) => {
  const userId = authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  const { payment_intent_id, amount_krw } = await c.req.json() as any;
  if (!payment_intent_id || !amount_krw) return c.json({ error: '잘못된 요청' }, 400);

  await ensurePaymentTable(c.env.DB);

  const dup = await c.env.DB.prepare('SELECT id,status FROM tl_payments WHERE pg_id=?').bind(payment_intent_id).first() as any;
  if (dup?.status === 'success') return c.json({ error: '이미 처리된 결제입니다' }, 409);

  const STRIPE_SECRET = (c.env as any).STRIPE_SECRET_KEY || 'sk_test_placeholder';

  let verified = false;
  let paidAmount = Number(amount_krw);

  // 테스트 mock
  if (payment_intent_id.startsWith('pi_test_mock_')) {
    verified = true;
  } else {
    try {
      const res = await fetch(`https://api.stripe.com/v1/payment_intents/${payment_intent_id}`, {
        headers: { 'Authorization': 'Basic ' + btoa(STRIPE_SECRET + ':') },
      });
      const data: any = await res.json();
      if (data.status === 'succeeded' && data.metadata?.user_id === userId) {
        paidAmount = data.amount;
        verified = true;
      }
    } catch (_e) {
      if (STRIPE_SECRET === 'sk_test_placeholder') verified = true;
    }
  }

  if (!verified) return c.json({ error: '결제 검증 실패' }, 400);

  const tlGranted = paidAmount;
  try {
    await c.env.DB.prepare('UPDATE users SET tl=tl+? WHERE id=?').bind(tlGranted, userId).run();
    await c.env.DB.prepare(
      `INSERT OR REPLACE INTO tl_payments (user_id,method,pg_id,merchant_uid,amount_krw,tl_granted,status)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(userId, 'stripe', payment_intent_id, '', paidAmount, tlGranted, 'success').run();

    const user = await c.env.DB.prepare('SELECT tl FROM users WHERE id=?').bind(userId).first() as any;
    return c.json({ success: true, tl_granted: tlGranted, tl_balance: user?.tl || 0 });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════
   결제 내역 조회
   GET /api/payment/history
══════════════════════════════════════════════════ */
payment.get('/history', async (c) => {
  const userId = authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  await ensurePaymentTable(c.env.DB);

  const rows = await c.env.DB.prepare(
    `SELECT method, amount_krw, tl_granted, status, created_at
     FROM tl_payments WHERE user_id=? ORDER BY created_at DESC LIMIT 20`
  ).bind(userId).all();

  return c.json({ payments: rows.results || [] });
});

export default payment;
