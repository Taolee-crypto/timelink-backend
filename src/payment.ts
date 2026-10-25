import { Hono } from 'hono';
import type { Env } from './types';
import { verifyToken } from './auth';
import { creditVerifiedPayment } from './v5-payment-ledger';
import { readV5Wallet } from './v5-wallet';
import { assertTLAtomScale } from './economy-ledger';
import { readRewardPolicy,paymentBonusMap } from './v5-reward-policy';

const payment = new Hono<{ Bindings: Env }>();

// V5 TL PREMIUM: cash promotion prices are informational until a separate
// verified PG order + airtime settlement pipeline is implemented.
// Never route promotion purchases through the ordinary TL top-up endpoints.
payment.get('/v5/premium/plans', (c) => c.json({
  ok: true,
  currency: 'KRW',
  krw_per_verified_airtime_second: 2.5,
  tl_per_verified_airtime_second: 5,
  tl_payment_bucket: 'TL_P',
  excluded_tl_buckets: ['TL_A','TL_B'],
  rates_are_independent: true,
  settlement_policy: 'verified_airtime_only',
  unused_budget_policy: 'return_unspent_on_cancellation',
  plans: [
    { id: 'trial', amount_krw: 5000, estimated_tl_budget_for_equivalent_airtime: 10000 },
    { id: 'basic', amount_krw: 15000, estimated_tl_budget_for_equivalent_airtime: 30000 },
    { id: 'focused', amount_krw: 30000, estimated_tl_budget_for_equivalent_airtime: 60000 },
    { id: 'premium', amount_krw: 50000, estimated_tl_budget_for_equivalent_airtime: 100000 }
  ],
  checkout_enabled: false,
  settlement_enabled: false,
  note: 'Cash promotion is separate from TL charging. Payment and verified airtime settlement are not yet enabled.'
}));


/* ──────────────────────────────────────────────────
   공통 유틸: 토큰 파싱 → user_id
────────────────────────────────────────────────── */
async function authUserId(c: any): Promise<string | null> {
  const auth = c.req.header('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  const secret = String((c.env as any).JWT_SECRET || '');
  if (!token || !secret) return null;
  const payload = await verifyToken(token, secret).catch(() => null);
  if (!payload?.sub || !/^\d+$/.test(String(payload.sub))) return null;
  const user=await c.env.DB.prepare('SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0').bind(payload.sub).first();
  return user?String(payload.sub):null;
}

// Preparation only: orders do not debit wallets or charge cards.
payment.post('/v5/premium/prepare',async c=>{
 const userId=await authUserId(c);
 if(!userId)return c.json({ok:false,error:'AUTH_REQUIRED'},401);
 const b=await c.req.json<any>().catch(()=>null);
 const amounts:Record<string,number>={trial:5000,basic:15000,focused:30000,premium:50000};
 const plan=String(b?.plan||''),method=String(b?.method||'');
 const fileId=Number(b?.file_id);
 if(!Object.prototype.hasOwnProperty.call(amounts,plan)||
    !['cash','tl'].includes(method)||!Number.isSafeInteger(fileId)||
    fileId<=0||b?.rights_accepted!==true)
   return c.json({ok:false,error:'INVALID_REQUEST'},400);
 try{
  // Promotion application is open to every published V5 track owned by the applicant.
  // Music-gate approval and creator rights are NOT promotion purchase prerequisites.
  // Broadcast licensing and any rights dispute remain independent gates before airtime.
  const file=await c.env.DB.prepare(`SELECT f.id FROM tl_files f
    JOIN tl3_v5_releases v ON v.file_id=f.id
    WHERE f.id=? AND f.user_id=? AND f.shared=1
      AND v.status='sealed' AND COALESCE(f.revenue_held,0)=0
    LIMIT 1`).bind(fileId,Number(userId)).first();
  if(!file)return c.json({ok:false,error:'NOT_ELIGIBLE',reason:'FILE_NOT_PUBLISHED_OR_NOT_OWNED'},403);
  const amount=amounts[plan];
  return c.json({ok:true,method,plan,file_id:fileId,
    amount_krw:method==='cash'?amount:null,
    amount_tl:method==='tl'?amount*2:null,
    order_created:false,checkout_enabled:false,
    note:'Eligibility verified only; no funds reserved or charged.'});
 }catch{return c.json({ok:false,error:'PREPARATION_UNAVAILABLE'},503);}
});

/* ──────────────────────────────────────────────────
   결제 내역 테이블 생성 (첫 요청 시 자동)
   CREATE TABLE tl_payments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     user_id TEXT NOT NULL,
     method TEXT NOT NULL,          -- toss | portone | stripe
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
   Toss 결제 주문 생성
   - 주문 ID를 로그인 사용자와 서버에서 묶는다.
   - 클라이언트가 임의의 orderId로 다른 사용자의 결제를 가로채지 못하게 한다.
══════════════════════════════════════════════════ */
async function ensureTossOrderTable(db: any) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS tl_toss_orders (
      order_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount_krw INTEGER NOT NULL,
      status TEXT DEFAULT 'ready',
      payment_key TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `).run();
}

/* ══════════════════════════════════════════════════
   TimeLink 내부 가상 충전
   - 실제 금융기관/PG를 호출하지 않는다.
   - 개발/테스트용으로 선택한 패키지를 즉시 TL로 지급한다.
   POST /api/payment/virtual/charge
   body: { amount }
══════════════════════════════════════════════════ */
payment.post('/virtual/charge', async (c) => {
  if (String(c.env.ENVIRONMENT || '').toLowerCase() === 'production') {
    return c.json({ error: '개발용 가상 충전은 운영 환경에서 사용할 수 없습니다.' }, 403);
  }
  const userId = await authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  try {
    const { amount } = await c.req.json() as any;
    const paidAmount = Number(amount);
    const rewardPolicy=await readRewardPolicy(c.env.DB);
    const bonusMap=paymentBonusMap(rewardPolicy.rules);

    if (!Number.isInteger(paidAmount) || !Object.prototype.hasOwnProperty.call(bonusMap, paidAmount)) {
      return c.json({ error: '지원하지 않는 충전 금액입니다.' }, 400);
    }

    const bonus_tl = bonusMap[paidAmount];
    const total_tl = paidAmount + bonus_tl;
    const pgId = 'VIRTUAL_' + String(userId) + '_' + Date.now() + '_' +
      crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();

    await ensurePaymentTable(c.env.DB);

    await creditVerifiedPayment(c.env.DB,{userId,method:'virtual',paymentId:pgId,orderId:pgId,paidTL:paidAmount,bonusTL:bonus_tl});
    const wallet=await readV5Wallet(c.env.DB,Number(userId));
    const user={tl:wallet.tl_balance,tl_p:wallet.tl_p};

    return c.json({
      success: true,
      mode: 'virtual',
      paid_amount: paidAmount,
      bonus_tl,
      total_tl,
      tl_granted: total_tl,
      tl_balance: Number(user?.tl || 0),
      tl_p: Number(user?.tl_p || 0)
    });
  } catch (e: any) {
    return c.json({ error: e?.message || '가상 충전 처리 실패' }, 500);
  }
});

async function createProviderOrder(c:any,provider:'toss'|'portone') {
  const userId = await authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);
  try {
    const { amount } = await c.req.json() as any;
    const paidAmount = Number(amount);
    const allowed = [5000, 10000, 30000, 50000, 100000];
    if (!Number.isInteger(paidAmount) || !allowed.includes(paidAmount)) {
      return c.json({ error: '지원하지 않는 충전 금액입니다.' }, 400);
    }
    await ensureTossOrderTable(c.env.DB);
    const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase();
    const orderId = 'TL_'+provider+'_'  + String(userId) + '_' + Date.now() + '_' + suffix;
    await c.env.DB.prepare(
      'INSERT INTO tl_toss_orders (order_id,user_id,amount_krw,status) VALUES (?,?,?,?)'
    ).bind(orderId, userId, paidAmount, 'ready').run();
    return c.json({ ok: true, orderId, amount: paidAmount });
  } catch (e: any) {
    return c.json({ error: e?.message || '결제 주문 생성 실패' }, 500);
  }
}
payment.post('/toss/order',c=>createProviderOrder(c,'toss'));
payment.post('/portone/order',c=>createProviderOrder(c,'portone'));

/* ══════════════════════════════════════════════════
   Toss Payments 결제 승인 + TL 지급
   POST /api/payment/toss/confirm
   body: { paymentKey, orderId, amount }
══════════════════════════════════════════════════ */
payment.post('/toss/confirm', async (c) => {
  const userId = await authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  const { paymentKey, orderId, amount } = await c.req.json() as any;
  const paidAmount = Number(amount);
  if (!paymentKey || !orderId || !Number.isInteger(paidAmount) || paidAmount <= 0) {
    return c.json({ error: '잘못된 결제 요청입니다' }, 400);
  }

  await ensurePaymentTable(c.env.DB);
  await ensureTossOrderTable(c.env.DB);

  // 주문은 서버에서 로그인 사용자에게 발급한 것만 승인한다.
  const order = await c.env.DB.prepare(
    'SELECT order_id,user_id,amount_krw,status,payment_key FROM tl_toss_orders WHERE order_id=?'
  ).bind(String(orderId)).first() as any;
  if (!order || String(order.user_id) !== String(userId)) {
    return c.json({ error: '결제 주문의 사용자 정보가 일치하지 않습니다.' }, 403);
  }
  if (Number(order.amount_krw) !== paidAmount) {
    return c.json({ error: '결제 금액이 주문 금액과 일치하지 않습니다.' }, 400);
  }
  if (order.status === 'success' && order.payment_key!==paymentKey) {
    return c.json({ error: '이미 다른 결제로 처리된 주문입니다.' }, 409);
  }

  // paymentKey를 고유 키로 사용하여 동일 결제의 중복 지급을 막는다.
  const dup = await c.env.DB.prepare(
    'SELECT id,user_id,merchant_uid,status,tl_granted FROM tl_payments WHERE pg_id=?'
  ).bind(paymentKey).first() as any;
  if (dup?.status === 'success') {
    if(String(dup.user_id)!==userId||String(dup.merchant_uid)!==String(orderId))return c.json({error:'PAYMENT_OWNER_MISMATCH'},403);
    const wallet=await readV5Wallet(c.env.DB,Number(userId));
    const user={tl:wallet.tl_balance,tl_p:wallet.tl_p};
    return c.json({
      success: true,
      already_processed: true,
      total_tl: Number(dup.tl_granted || 0),
      bonus_tl: Math.max(0, Number(dup.tl_granted || 0) - paidAmount),
      tl_balance: Number(user?.tl || 0),
      tl_p: Number(user?.tl_p || 0)
    });
  }

  try {await assertTLAtomScale(c.env.DB);}catch{return c.json({error:'V5_LEDGER_NOT_READY'},503);}

  const TOSS_SECRET = (c.env as any).TOSS_SECRET_KEY || '';
  if (!TOSS_SECRET) {
    return c.json({ error: 'Toss 결제 검증 키(TOSS_SECRET_KEY)가 서버에 설정되지 않았습니다.' }, 503);
  }

  try {
    const auth = btoa(TOSS_SECRET + ':');
    const verifyRes = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ paymentKey, orderId, amount: paidAmount })
    });
    const verified: any = await verifyRes.json();

    if (!verifyRes.ok || Number(verified?.totalAmount) !== paidAmount || verified?.status !== 'DONE') {
      return c.json({
        error: verified?.message || 'Toss 결제 승인/금액 검증 실패',
        code: verified?.code || 'TOSS_VERIFY_FAILED'
      }, 400);
    }

    // 결제 금액별 보너스는 SharePlace의 충전 패키지와 동일하게 적용한다.
    const rewardPolicy=await readRewardPolicy(c.env.DB);
    const bonusMap=paymentBonusMap(rewardPolicy.rules);
    const bonus_tl = bonusMap[paidAmount] || 0;
    const total_tl = paidAmount + bonus_tl;

    await creditVerifiedPayment(c.env.DB,{userId,method:'toss',paymentId:paymentKey,orderId,
      paidTL:paidAmount,bonusTL:bonus_tl,atomicStatements:[c.env.DB.prepare(
        "UPDATE tl_toss_orders SET status='success', payment_key=?, updated_at=datetime('now') WHERE order_id=? AND user_id=? AND status='ready'"
      ).bind(paymentKey,orderId,userId)]});
    const wallet=await readV5Wallet(c.env.DB,Number(userId));
    const user={tl:wallet.tl_balance,tl_p:wallet.tl_p};

    return c.json({
      success: true,
      paid_amount: paidAmount,
      bonus_tl,
      total_tl,
      tl_granted: total_tl,
      tl_balance: Number(user?.tl || 0),
      tl_p: Number(user?.tl_p || 0)
    });
  } catch (e: any) {
    return c.json({ error: e?.message || 'Toss 결제 처리 실패' }, 500);
  }
});

/* ══════════════════════════════════════════════════
   포트원(아임포트) 결제 검증 + TL 지급
   POST /api/payment/portone/verify
   body: { imp_uid, merchant_uid, amount, user_id? }
══════════════════════════════════════════════════ */
payment.post('/portone/verify', async (c) => {
  const userId = await authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  const { imp_uid, merchant_uid, amount } = await c.req.json() as any;
  if (!imp_uid || !amount || amount <= 0) {
    return c.json({ error: '잘못된 결제 요청입니다' }, 400);
  }

  await ensurePaymentTable(c.env.DB);
  await ensureTossOrderTable(c.env.DB);
  try{await assertTLAtomScale(c.env.DB);}catch{return c.json({error:'V5_LEDGER_NOT_READY'},503);}
  const order=await c.env.DB.prepare('SELECT * FROM tl_toss_orders WHERE order_id=? AND user_id=?').bind(String(merchant_uid||''),userId).first<any>();
  if(!order||Number(order.amount_krw)!==Number(amount)||!String(order.order_id).startsWith('TL_portone_'))return c.json({error:'SERVER_PAYMENT_ORDER_REQUIRED'},403);

  // 중복 결제 방지
  const dup = await c.env.DB.prepare('SELECT id FROM tl_payments WHERE pg_id=?').bind(imp_uid).first();
  if (dup) return c.json({ error: '이미 처리된 결제입니다' }, 409);

  // ── 포트원 액세스 토큰 발급 ──
  const IMP_KEY    = String((c.env as any).PORTONE_IMP_KEY || '');
  const IMP_SECRET = String((c.env as any).PORTONE_IMP_SECRET || '');
  if (!IMP_KEY || !IMP_SECRET) return c.json({ error: 'PortOne 서버 키가 설정되지 않았습니다.' }, 503);

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
        if (paidAmount === Number(amount) && payment.merchant_uid===merchant_uid) {
          verified = true;
        }
      }
    }
  } catch (_e) {
    verified = false;
  }

  if (!verified) {
    return c.json({ error: '결제 검증 실패' }, 400);
  }

  // TL 지급 (1원 = 1TL)
  const tlGranted = paidAmount;

  try {
    await creditVerifiedPayment(c.env.DB,{userId,method:'portone',paymentId:imp_uid,orderId:merchant_uid||'',paidTL:tlGranted,bonusTL:0,atomicStatements:[c.env.DB.prepare("UPDATE tl_toss_orders SET status='success',payment_key=?,updated_at=datetime('now') WHERE order_id=? AND user_id=? AND status='ready'").bind(imp_uid,merchant_uid,userId)]});
    const wallet=await readV5Wallet(c.env.DB,Number(userId));
    const user={tl:wallet.tl_balance};
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
  const userId = await authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  const { amount_krw } = await c.req.json() as any;
  if (!amount_krw || amount_krw < 100) {
    return c.json({ error: '최소 결제 금액은 100원입니다' }, 400);
  }

  const STRIPE_SECRET = String((c.env as any).STRIPE_SECRET_KEY || '');
  if (!STRIPE_SECRET) return c.json({ error: 'Stripe 서버 키가 설정되지 않았습니다.' }, 503);

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

    if (data.error) return c.json({ error: data.error.message }, 400);

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
  const userId = await authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  const { payment_intent_id, amount_krw } = await c.req.json() as any;
  if (!payment_intent_id || !amount_krw) return c.json({ error: '잘못된 요청' }, 400);

  await ensurePaymentTable(c.env.DB);

  const dup = await c.env.DB.prepare('SELECT id,status FROM tl_payments WHERE pg_id=?').bind(payment_intent_id).first() as any;
  if (dup?.status === 'success') return c.json({ error: '이미 처리된 결제입니다' }, 409);

  const STRIPE_SECRET = String((c.env as any).STRIPE_SECRET_KEY || '');
  if (!STRIPE_SECRET) return c.json({ error: 'Stripe 서버 키가 설정되지 않았습니다.' }, 503);

  let verified = false;
  let paidAmount = Number(amount_krw);

  try {
      const res = await fetch(`https://api.stripe.com/v1/payment_intents/${payment_intent_id}`, {
        headers: { 'Authorization': 'Basic ' + btoa(STRIPE_SECRET + ':') },
      });
      const data: any = await res.json();
      if (data.status === 'succeeded' && data.currency==='krw' && Number(data.amount_received)===Number(amount_krw) && data.metadata?.user_id === userId) {
        paidAmount = data.amount;
        verified = true;
      }
  } catch (_e) {
    verified = false;
  }

  if (!verified) return c.json({ error: '결제 검증 실패' }, 400);

  const tlGranted = paidAmount;
  try {
    await creditVerifiedPayment(c.env.DB,{userId,method:'stripe',paymentId:payment_intent_id,orderId:'',paidTL:tlGranted,bonusTL:0});
    const wallet=await readV5Wallet(c.env.DB,Number(userId));
    const user={tl:wallet.tl_balance,tl_p:wallet.tl_p};
    return c.json({ success: true, tl_granted: tlGranted, tl_balance: user?.tl || 0, tl_p: user?.tl_p || 0 });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════
   결제 내역 조회
   GET /api/payment/history
══════════════════════════════════════════════════ */
payment.get('/history', async (c) => {
  const userId = await authUserId(c);
  if (!userId) return c.json({ error: '인증이 필요합니다' }, 401);

  await ensurePaymentTable(c.env.DB);

  const rows = await c.env.DB.prepare(
    `SELECT method, amount_krw, tl_granted, status, created_at
     FROM tl_payments WHERE user_id=? ORDER BY created_at DESC LIMIT 20`
  ).bind(userId).all();

  return c.json({ payments: rows.results || [] });
});

export default payment;
