import { Hono } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';

const router = new Hono<{ Bindings: Env }>();

// ── 인증 헬퍼 ──
async function authUser(c: any): Promise<{id: number, user: any} | null> {
  const auth = (c.req.header('Authorization') || '').replace(/^Bearer\s+/, '').trim();
  if (!auth) return null;
  const payload = await verifyToken(auth, c.env.JWT_SECRET).catch(() => null);
  if (!payload) return null;
  const userId = Number(payload.sub || 0);
  if (!userId) return null;
  const user = await c.env.DB.prepare('SELECT id, email, username, tl, tl_balance FROM users WHERE id=?').bind(userId).first<any>();
  if (!user) return null;
  return { id: userId, user };
}

// ── 지원 국가 ──
const SUPPORTED_COUNTRIES = ['KR', 'US', 'JP', 'CN', 'GB'];

// ── 국가별 사업자번호 검증 ──
type VerifyResult = { ok: boolean; verified: boolean; error?: string };

function verifyKR(bizNo: string): VerifyResult {
  const cleaned = bizNo.replace(/-/g, '').trim();
  if (!/^\d{10}$/.test(cleaned)) return { ok: false, verified: false, error: '한국 사업자등록번호는 10자리 숫자입니다.' };
  const weights = [1,3,7,1,3,7,1,3,5];
  const nums = cleaned.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += nums[i] * weights[i];
  sum += Math.floor((nums[8] * 5) / 10);
  const checkDigit = (10 - (sum % 10)) % 10;
  if (checkDigit !== nums[9]) return { ok: false, verified: false, error: '한국 사업자등록번호 체크섬이 올바르지 않습니다.' };
  return { ok: true, verified: false };
}

function verifyUS(bizNo: string): VerifyResult {
  const cleaned = bizNo.replace(/-/g, '').trim();
  if (!/^\d{9}$/.test(cleaned)) return { ok: false, verified: false, error: '미국 EIN은 9자리 숫자입니다.' };
  return { ok: true, verified: false };
}

function verifyJP(bizNo: string): VerifyResult {
  const cleaned = bizNo.replace(/-/g, '').trim();
  if (!/^\d{13}$/.test(cleaned)) return { ok: false, verified: false, error: '일본 법인번호는 13자리 숫자입니다.' };
  return { ok: true, verified: false };
}

function verifyCN(bizNo: string): VerifyResult {
  const cleaned = bizNo.replace(/-/g, '').trim().toUpperCase();
  if (!/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(cleaned)) return { ok: false, verified: false, error: '중국 통일사회신용코드는 18자리입니다.' };
  // 체크섬
  const code = '0123456789ABCDEFGHJKLMNPQRTUWXY';
  const weights = [1,3,9,27,19,26,16,17,20,29,25,13,8,24,10,30,28];
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const idx = code.indexOf(cleaned[i]);
    if (idx < 0) return { ok: false, verified: false, error: '중국 통일사회신용코드에 허용되지 않은 문자입니다.' };
    sum += idx * weights[i];
  }
  const checkIdx = (31 - (sum % 31)) % 31;
  if (code[checkIdx] !== cleaned[17]) return { ok: false, verified: false, error: '중국 통일사회신용코드 체크섬이 올바르지 않습니다.' };
  return { ok: true, verified: false };
}

function verifyGB(bizNo: string): VerifyResult {
  const cleaned = bizNo.replace(/[\s-]/g, '').trim().toUpperCase().replace(/^GB/, '');
  if (!/^\d{9}$|^\d{12}$/.test(cleaned)) return { ok: false, verified: false, error: '영국 VAT 번호는 9자리 또는 12자리 숫자입니다.' };
  return { ok: true, verified: false };
}

async function verifyBizRegNum(c: any, country: string, bizNo: string): Promise<VerifyResult> {
  const cc = String(country || 'KR').toUpperCase();
  if (!SUPPORTED_COUNTRIES.includes(cc)) {
    return { ok: false, verified: false, error: '지원하지 않는 국가입니다.' };
  }
  let result: VerifyResult;
  switch (cc) {
    case 'KR': result = verifyKR(bizNo); break;
    case 'US': result = verifyUS(bizNo); break;
    case 'JP': result = verifyJP(bizNo); break;
    case 'CN': result = verifyCN(bizNo); break;
    case 'GB': result = verifyGB(bizNo); break;
    default: return { ok: false, verified: false, error: '지원하지 않는 국가입니다.' };
  }
  if (!result.ok) return result;
  // 국세청/IRS 등 API 연동 여부 확인
  let enabled = false;
  try {
    await c.env.DB.prepare("CREATE TABLE IF NOT EXISTS tl_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT DEFAULT (datetime('now')))").run().catch(()=>{});
    const row = await c.env.DB.prepare("SELECT value FROM tl_settings WHERE key='biz_verify_enabled'").first<any>();
    enabled = String(row?.value || '').toLowerCase() === 'true';
  } catch(_) {}
  if (!enabled) return { ok: true, verified: false };
  // TODO: 국가별 API 연동
  // KR: 국세청 홈택스 / US: IRS TIN / JP: 国税庁 / CN: 国家企业信用 / GB: HMRC VIES
  return { ok: true, verified: false };
}

// ── 테이블 보장 ──
async function ensureCafeTables(db: any) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS cafe_channels (
    channel_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL,
    country TEXT DEFAULT 'KR',
    biz_reg_num TEXT DEFAULT '',
    biz_type TEXT DEFAULT 'individual',
    biz_verified INTEGER DEFAULT 0,
    biz_verified_at INTEGER DEFAULT 0,
    addr TEXT DEFAULT '',
    addr_detail TEXT DEFAULT '',
    description TEXT DEFAULT '',
    images TEXT DEFAULT '[]',
    playlist TEXT DEFAULT '[]',
    schedules TEXT DEFAULT '[]',
    plan TEXT DEFAULT 'free',
    status TEXT DEFAULT 'active',
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run().catch(()=>{});

  // 기존 테이블에 누락된 컬럼 자동 추가 (마이그레이션)
  const migrations = [
    "ALTER TABLE cafe_channels ADD COLUMN country TEXT DEFAULT 'KR'",
    "ALTER TABLE cafe_channels ADD COLUMN biz_reg_num TEXT DEFAULT ''",
    "ALTER TABLE cafe_channels ADD COLUMN biz_type TEXT DEFAULT 'individual'",
    "ALTER TABLE cafe_channels ADD COLUMN biz_verified INTEGER DEFAULT 0",
    "ALTER TABLE cafe_channels ADD COLUMN biz_verified_at INTEGER DEFAULT 0",
    "ALTER TABLE cafe_channels ADD COLUMN addr TEXT DEFAULT ''",
    "ALTER TABLE cafe_channels ADD COLUMN addr_detail TEXT DEFAULT ''",
    "ALTER TABLE cafe_channels ADD COLUMN description TEXT DEFAULT ''",
    "ALTER TABLE cafe_channels ADD COLUMN images TEXT DEFAULT '[]'",
    "ALTER TABLE cafe_channels ADD COLUMN playlist TEXT DEFAULT '[]'",
    "ALTER TABLE cafe_channels ADD COLUMN schedules TEXT DEFAULT '[]'",
    "ALTER TABLE cafe_channels ADD COLUMN plan TEXT DEFAULT 'free'",
    "ALTER TABLE cafe_channels ADD COLUMN status TEXT DEFAULT 'active'",
    "ALTER TABLE cafe_channels ADD COLUMN expires_at INTEGER",
    "ALTER TABLE cafe_channels ADD COLUMN created_at INTEGER",
    "ALTER TABLE cafe_channels ADD COLUMN updated_at INTEGER"
  ];
  for (const sql of migrations) {
    await db.prepare(sql).run().catch(()=>{});
  }
}

// ── GET /api/cafe/countries — 지원 국가 목록 ──
router.get('/countries', (c) => {
  return c.json({
    ok: true,
    countries: [
      { code: 'KR', name: '대한민국', name_en: 'South Korea', flag: '🇰🇷', placeholder: '000-00-00000', label: '사업자등록번호' },
      { code: 'US', name: '미국', name_en: 'United States', flag: '🇺🇸', placeholder: '00-0000000', label: 'EIN' },
      { code: 'JP', name: '일본', name_en: 'Japan', flag: '🇯🇵', placeholder: '0000000000000', label: '법인番号' },
      { code: 'CN', name: '중국', name_en: 'China', flag: '🇨🇳', placeholder: '00000000000000000X', label: '统一社会信用代码' },
      { code: 'GB', name: '영국', name_en: 'United Kingdom', flag: '🇬🇧', placeholder: 'GB000000000', label: 'VAT Number' }
    ]
  });
});

// ── GET /api/cafe/channels — 채널 목록 ──
router.get('/channels', async (c) => {
  try {
    await ensureCafeTables(c.env.DB);
    const { results } = await c.env.DB.prepare(
      `SELECT channel_id, name, country, addr, description, images, playlist, plan, status, expires_at, created_at
       FROM cafe_channels
       WHERE status='active' AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY created_at DESC LIMIT 100`
    ).bind(Date.now()).all();
    return c.json({ ok: true, channels: results || [] });
  } catch (e: any) {
    return c.json({ ok: false, channels: [], error: e?.message || '채널 목록 조회 실패' }, 500);
  }
});

// ── POST /api/cafe/channels — 채널 개설 ──
router.post('/channels', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);

  const body = await c.req.json<any>().catch(() => ({}));
  const channelId = String(body.channel_id || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const country = String(body.country || 'KR').toUpperCase();
  const bizNo = String(body.biz_reg_num || '').trim();
  const bizType = String(body.biz_type || 'individual').toLowerCase();
  const addr = String(body.addr || '').trim();
  const addrDetail = String(body.addr_detail || '').trim();
  const description = String(body.description || '').trim();
  const images = JSON.stringify(body.images || []);
  const playlist = JSON.stringify(body.playlist || []);
  const schedules = JSON.stringify(body.schedules || []);
  const trial = !!body.trial;
  const trialDays = Math.max(1, Math.min(180, Number(body.trial_days) || 90));
  const discountCode = String(body.discount_code || '').trim().toUpperCase();

  if (!name) return c.json({ ok: false, error: '카페 이름은 필수입니다.' }, 400);
  if (!/^[a-z0-9_]{3,20}$/.test(channelId)) return c.json({ ok: false, error: '채널 ID는 영문 소문자/숫자/언더스코어 3~20자입니다.' }, 400);
  if (!SUPPORTED_COUNTRIES.includes(country)) return c.json({ ok: false, error: '지원하지 않는 국가입니다.' }, 400);
  if (!bizNo) return c.json({ ok: false, error: '사업자등록번호는 필수입니다.' }, 400);
  if (!['individual','corporate','other'].includes(bizType)) return c.json({ ok: false, error: '사업자 유형이 올바르지 않습니다.' }, 400);

  const bizCheck = await verifyBizRegNum(c, country, bizNo);
  if (!bizCheck.ok) return c.json({ ok: false, error: bizCheck.error || '사업자등록번호 검증 실패' }, 400);

  await ensureCafeTables(c.env.DB);
  const existing = await c.env.DB.prepare('SELECT channel_id FROM cafe_channels WHERE channel_id=?').bind(channelId).first<any>();
  if (existing) return c.json({ ok: false, error: '이미 사용 중인 채널 ID입니다.' }, 409);

  let channelFee = 50000;
  try {
    const feeRow = await c.env.DB.prepare("SELECT value FROM tl_settings WHERE key='cafe_channel_fee'").first<any>();
    if (feeRow?.value) channelFee = Number(feeRow.value) || 50000;
  } catch(_) {}

  // ⭐ 할인 코드 검증
  let finalFee = channelFee;
  let appliedDiscount: any = null;
  if (discountCode) {
    const disc = await c.env.DB.prepare(
      'SELECT * FROM discounts WHERE code=? AND applies_to=? AND is_active=1'
    ).bind(discountCode, 'cafe_channel').first<any>();
    if (disc) {
      const nowT = Date.now();
      const valid = (!disc.starts_at || disc.starts_at <= nowT) &&
                    (!disc.expires_at || disc.expires_at >= nowT) &&
                    (!disc.max_uses || disc.uses < disc.max_uses);
      if (valid) {
        const amt = disc.type === 'percent' ? channelFee * (disc.value / 100) : disc.value;
        finalFee = Math.max(0, channelFee - Math.min(channelFee, amt));
        appliedDiscount = disc;
      }
    }
  }

  // ⭐ trial=true → 무료 체험 (finalFee = 0)
  if (trial) finalFee = 0;

  const user = await c.env.DB.prepare('SELECT tl, tl_balance FROM users WHERE id=?').bind(auth.id).first<any>();
  const bal = Number(user?.tl_balance ?? user?.tl ?? 0);
  if (finalFee > 0 && bal < finalFee) return c.json({ ok: false, error: `TL 잔액이 부족합니다. (필요: ${finalFee.toLocaleString()} TL, 보유: ${bal.toLocaleString()} TL)` }, 402);

  const now = Date.now();
  const expiresAt = trial ? (now + trialDays * 24 * 60 * 60 * 1000) : (now + 30 * 24 * 60 * 60 * 1000);

  try {
    if (finalFee > 0) {
      await c.env.DB.prepare(
        'UPDATE users SET tl = tl - ?, tl_balance = tl_balance - ? WHERE id = ?'
      ).bind(finalFee, finalFee, auth.id).run();
    }

    await c.env.DB.prepare(
      `INSERT INTO cafe_channels
       (channel_id, name, owner_id, country, biz_reg_num, biz_type, biz_verified, biz_verified_at,
        addr, addr_detail, description, images, playlist, schedules,
        plan, status, expires_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      channelId, name, auth.id, country, bizNo, bizType, bizCheck.verified ? 1 : 0, bizCheck.verified ? now : 0,
      addr, addrDetail, description, images, playlist, schedules,
      trial ? 'trial' : 'free', 'active', expiresAt, now, now
    ).run();

    // ⭐ 체험 구독 생성
    if (trial) {
      const ins = await c.env.DB.prepare(
        "INSERT INTO cafe_subscriptions (cafe_channel_id, owner_id, plan, status, trial_started_at, trial_ends_at, amount_tl, auto_renew, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
      ).bind(channelId, auth.id, 'basic', 'trialing', now, expiresAt, 0, 1, now, now).run();
      await c.env.DB.prepare(
        "INSERT INTO subscription_events (subscription_id, event_type, amount_tl, metadata, created_at) VALUES (?,?,?,?,?)"
      ).bind(ins.meta?.last_row_id || 0, 'trial_started', 0, JSON.stringify({ trial_days: trialDays, source: 'channel_create' }), now).run();
    }

    // ⭐ 할인 사용 기록
    if (appliedDiscount) {
      await c.env.DB.prepare("UPDATE discounts SET uses = uses + 1 WHERE id=?").bind(appliedDiscount.id).run();
      await c.env.DB.prepare(
        "INSERT INTO discount_uses (discount_id, user_id, target_type, target_id, amount_saved, created_at) VALUES (?,?,?,?,?,?)"
      ).bind(appliedDiscount.id, auth.id, 'cafe_channel', channelId, channelFee - finalFee, now).run();
    }

    if (finalFee > 0) {
      await c.env.DB.prepare(
        'INSERT INTO poc_logs (user_id, mode, seconds, tl_spent, poc_gained) VALUES (?, ?, 0, ?, 0)'
      ).bind(auth.id, 'consume', finalFee).run().catch(()=>{});
    }

    return c.json({
      ok: true,
      channel_id: channelId,
      name,
      country,
      expires_at: expiresAt,
      fee: finalFee,
      original_fee: channelFee,
      trial: trial,
      trial_days: trial ? trialDays : 0,
      discount_code: appliedDiscount ? appliedDiscount.code : null,
      discount_saved: appliedDiscount ? (channelFee - finalFee) : 0,
      biz_verified: bizCheck.verified
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '채널 개설 실패' }, 500);
  }
});

// ── GET /api/cafe/channels/:id ──
router.get('/channels/:id', async (c) => {
  try {
    await ensureCafeTables(c.env.DB);
    const channelId = c.req.param('id');
    const row = await c.env.DB.prepare('SELECT * FROM cafe_channels WHERE channel_id=?').bind(channelId).first<any>();
    if (!row) return c.json({ ok: false, error: '채널을 찾을 수 없습니다.' }, 404);
    return c.json({ ok: true, channel: row });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '채널 조회 실패' }, 500);
  }
});

// ── PUT /api/cafe/channels/:id ──
router.put('/channels/:id', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);

  const channelId = c.req.param('id');
  const body = await c.req.json<any>().catch(() => ({}));

  await ensureCafeTables(c.env.DB);
  const row = await c.env.DB.prepare('SELECT owner_id FROM cafe_channels WHERE channel_id=?').bind(channelId).first<any>();
  if (!row) return c.json({ ok: false, error: '채널을 찾을 수 없습니다.' }, 404);
  if (Number(row.owner_id) !== auth.id) return c.json({ ok: false, error: '권한이 없습니다.' }, 403);

  const fields: string[] = [];
  const values: any[] = [];
  const allowed = ['name','addr','addr_detail','description','images','playlist','schedules','status'];
  for (const k of allowed) {
    if (body[k] !== undefined) {
      fields.push(`${k}=?`);
      values.push(typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]);
    }
  }
  if (!fields.length) return c.json({ ok: false, error: '수정할 항목이 없습니다.' }, 400);

  fields.push('updated_at=?');
  values.push(Date.now());
  values.push(channelId);

  try {
    await c.env.DB.prepare(`UPDATE cafe_channels SET ${fields.join(',')} WHERE channel_id=?`).bind(...values).run();
    return c.json({ ok: true, channel_id: channelId });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '채널 수정 실패' }, 500);
  }
});

// ── DELETE /api/cafe/channels/:id ──
router.delete('/channels/:id', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);

  const channelId = c.req.param('id');
  await ensureCafeTables(c.env.DB);
  const row = await c.env.DB.prepare('SELECT owner_id FROM cafe_channels WHERE channel_id=?').bind(channelId).first<any>();
  if (!row) return c.json({ ok: false, error: '채널을 찾을 수 없습니다.' }, 404);
  if (Number(row.owner_id) !== auth.id) return c.json({ ok: false, error: '권한이 없습니다.' }, 403);

  try {
    await c.env.DB.prepare('UPDATE cafe_channels SET status=?, updated_at=? WHERE channel_id=?').bind('deleted', Date.now(), channelId).run();
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || '채널 삭제 실패' }, 500);
  }
});

export default router;
