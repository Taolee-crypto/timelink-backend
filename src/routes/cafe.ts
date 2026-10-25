import {assignmentPlan,settleCafeService} from '../sales-managers';
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../types';
import { verifyToken } from '../auth';
import { assertTLAtomScale, tlToAtoms, atomsToTl, ensureLedgerAccount, postLedgerTransaction } from '../economy-ledger';

const router = new Hono<{ Bindings: Env }>();

// ── 인증 헬퍼 ──
async function authUser(c: Context<{ Bindings: Env }>): Promise<{id: number, user: any} | null> {
  const auth = (c.req.header('Authorization') || '').replace(/^Bearer\s+/, '').trim();
  if (!auth) return null;
  const payload = await verifyToken(auth, c.env.JWT_SECRET).catch(() => null);
  if (!payload) return null;
  const userId = Number(payload.sub || 0);
  if (!userId) return null;
  const user = await c.env.DB.prepare('SELECT id, email, username, tl, tl_balance FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0').bind(userId).first<any>();
  if (!user) return null;
  return { id: userId, user };
}

// ── 지원 국가 ──
const SUPPORTED_COUNTRIES = ['KR', 'US', 'JP', 'CN', 'GB'];

// ── 국가별 사업자번호 검증 ──
type VerifyResult = { ok: boolean; verified: boolean; error?: string };

function verifyKR(bizNo: string): VerifyResult {
  // 국세청 실시간 인증이 비활성화된 동안에는 표시용 하이픈을 제거하고
  // 숫자 10자리 형식만 검증한다. 체크섬을 실제 사업자 인증으로 오인하지 않는다.
  const cleaned = bizNo.replace(/\D/g, '');
  if (!/^\d{10}$/.test(cleaned)) return { ok: false, verified: false, error: '사업자등록번호는 숫자 10자리로 입력해주세요.' };
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

async function verifyBizRegNum(c: Context<{ Bindings: Env }>, country: string, bizNo: string): Promise<VerifyResult> {
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

// ── GET /api/cafe/my-channels — 인증된 소유자 본인 채널 ──
router.get('/my-channels', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);
  try {
    await ensureCafeTables(c.env.DB);
    const { results } = await c.env.DB.prepare(
      `SELECT channel_id, name, owner_id, country, addr, description, images, playlist, schedules, plan, status, expires_at, created_at
       FROM cafe_channels WHERE owner_id=? ORDER BY created_at DESC`
    ).bind(auth.id).all();
    return c.json({ ok: true, channels: results || [] });
  } catch (e: any) {
    return c.json({ ok: false, channels: [], error: e?.message || '내 카페 채널 조회 실패' }, 500);
  }
});

// ── POST /api/cafe/channels — 채널 개설 ──
router.post('/channels', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ ok: false, error: '인증 필요' }, 401);

  // 카페 채널은 개인회원 가입 때 사용한 동일 계정의 이메일 인증이 완료되어야 개설할 수 있다.
  const emailState = await c.env.DB.prepare(
    'SELECT COALESCE(email_verified,0) AS email_verified FROM users WHERE id=?'
  ).bind(auth.id).first<any>();
  if (Number(emailState?.email_verified || 0) !== 1) {
    return c.json({
      ok: false,
      code: 'EMAIL_NOT_VERIFIED',
      error: '카페 채널을 개설하려면 TimeLink 개인회원 계정의 이메일 인증을 먼저 완료해주세요.'
    }, 403);
  }

  const body = await c.req.json<any>().catch(() => ({}));
  const channelId = 'cafe_' + crypto.randomUUID().replace(/-/g,'').slice(0,16);
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
  const trial = false; // V5 store membership is free, not a time-limited trial.
  const trialDays = Math.max(1, Math.min(180, Number(body.trial_days) || 90));
  const discountCode = String(body.discount_code || '').trim().toUpperCase();

  if (!name) return c.json({ ok: false, error: '카페 이름은 필수입니다.' }, 400);
  if (!SUPPORTED_COUNTRIES.includes(country)) return c.json({ ok: false, error: '지원하지 않는 국가입니다.' }, 400);
  if (!bizNo) return c.json({ ok: false, error: '사업자등록번호는 필수입니다.' }, 400);
  if (!['individual','corporate','other'].includes(bizType)) return c.json({ ok: false, error: '사업자 유형이 올바르지 않습니다.' }, 400);

  const bizCheck = await verifyBizRegNum(c, country, bizNo);
  if (!bizCheck.ok) return c.json({ ok: false, error: bizCheck.error || '사업자등록번호 검증 실패' }, 400);

  await ensureCafeTables(c.env.DB);
  const existing = await c.env.DB.prepare('SELECT channel_id FROM cafe_channels WHERE channel_id=?').bind(channelId).first<any>();
  if (existing) return c.json({ ok: false, error: '이미 사용 중인 채널 ID입니다.' }, 409);

  const requestId=String(body.request_id||'');
  if(requestId&&!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId))return c.json({ok:false,error:'등록 요청 번호 확인 필요'},400);
  const requestKey=requestId?'store:create:'+auth.id+':'+requestId:'';
  const inputHash=JSON.stringify({name,country,bizNo,addr,manager:body.sales_manager_id||null,invite:body.sales_invite_code||null,dj:body.dj_id||null,kind:body.store_kind||'cafe'});
  if(requestKey){
    const previous=await c.env.DB.prepare('SELECT input_hash,result_json FROM v5_sales_channel_requests WHERE request_key=? AND owner_id=?').bind(requestKey,auth.id).first<any>();
    if(previous){if(previous.input_hash!==inputHash)return c.json({ok:false,error:'같은 요청 번호로 다른 매장을 등록할 수 없습니다.'},409);return c.json({...JSON.parse(previous.result_json),already:true});}
  }
  let salesBinding:Awaited<ReturnType<typeof assignmentPlan>>|null=null;
  if(body.sales_invite_code||body.sales_manager_id){
    if(body.sales_accept!==true)return c.json({ok:false,error:'상점주의 영업 매니저 연결 동의가 필요합니다.'},400);
    try{salesBinding=await assignmentPlan(c.env.DB,{channel_id:channelId,owner_id:auth.id,country},auth.id,{
      invite_code:body.sales_invite_code||undefined,manager_user_id:Number(body.sales_manager_id||0),dj_id:Number(body.dj_id),
      kind:body.store_kind||'cafe',expected_version:0,reason:'상점주 매장 개설 및 담당 매니저 연결 동의'
    });}catch(e:any){return c.json({ok:false,error:e.message},400);}
  }

  // V5: store registration is free; legacy paid channel signup is retired.
  const channelFee = 0; // Retired paid cafe signup; do not read legacy fee settings.

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

  // V5 economic ledger is the sole source of spendable TL.
  let walletSources: Array<{accountId:string; available:number}> = [];
  let feeAtoms = 0;
  if (finalFee > 0) {
    try {
      await assertTLAtomScale(c.env.DB);
      feeAtoms = tlToAtoms(finalFee);
      for (const bucket of ['wallet_ad','wallet_bonus','wallet_paid']) {
        const accountId = await ensureLedgerAccount(c.env.DB,'user',auth.id,'TL',bucket);
        const row = await c.env.DB.prepare('SELECT available_atoms FROM v3_economy_balances WHERE account_id=?').bind(accountId).first<any>();
        walletSources.push({accountId,available:Number(row?.available_atoms||0)});
      }
      const total = walletSources.reduce((sum,source)=>sum+source.available,0);
      if (total < feeAtoms) return c.json({ok:false,error:`TL 잔액이 부족합니다. (필요: ${finalFee.toLocaleString()} TL, 보유: ${atomsToTl(total).toLocaleString()} TL)`},402);
    } catch(e:any) {
      return c.json({ok:false,error:'V5 경제원장 조회 실패: '+String(e?.message||e)},503);
    }
  }

  const now = Date.now();
  // Free store membership does not expire after the old 30-day paid cycle.
  const expiresAt = trial ? (now + trialDays * 24 * 60 * 60 * 1000) : Date.UTC(9999, 0, 1);

  try {
    // Channel creation and TL posting are committed together in one D1 batch.
    const channelInsert = c.env.DB.prepare(
      `INSERT INTO cafe_channels
       (channel_id, name, owner_id, country, biz_reg_num, biz_type, biz_verified, biz_verified_at,
        addr, addr_detail, description, images, playlist, schedules,
        plan, status, expires_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      channelId, name, auth.id, country, bizNo, bizType, bizCheck.verified ? 1 : 0, bizCheck.verified ? now : 0,
      addr, addrDetail, description, images, playlist, schedules,
      trial ? 'trial' : 'free', 'active', expiresAt, now, now
    );

    const salesStatements=[...(salesBinding?.statements||[])];
    if(requestKey)salesStatements.push(c.env.DB.prepare('INSERT INTO v5_sales_channel_requests(request_key,owner_id,channel_id,input_hash,result_json)VALUES(?,?,?,?,?)')
      .bind(requestKey,auth.id,channelId,inputHash,JSON.stringify({ok:true,channel_id:channelId,name,country,expires_at:expiresAt,fee:finalFee,original_fee:channelFee,trial,trial_days:trial?trialDays:0})));
    if(finalFee>0){
      await settleCafeService(c.env.DB,{payerId:auth.id,channelId,amountAtoms:feeAtoms,key:requestKey||'cafe:create:'+channelId,
        managerId:salesBinding?.manager_user_id,djUserId:salesBinding?.dj_user_id,
        atomic:[channelInsert,...salesStatements],metadata:{service:'channel_open',fee_tl:finalFee}});
    }else await c.env.DB.batch([channelInsert,...salesStatements]);

    // Store welcome top-up: 42,500 TL personal signup + 57,500 TL store bonus.
    // A user receives this top-up only once, regardless of store count.
    // Channel was already created: do not turn a successful signup into an error if bonus posting fails.
    // Ledger posting remains idempotent and can be retried separately.
    try {
    await assertTLAtomScale(c.env.DB);
    const welcomeKey = 'v5-store-welcome-user-' + auth.id;
    const priorWelcome = await c.env.DB.prepare('SELECT id FROM v3_economy_transactions WHERE idempotency_key=?')
      .bind(welcomeKey).first<any>();
    if (!priorWelcome) {
      const bonusAtoms = tlToAtoms(57500);
      const destination = await ensureLedgerAccount(c.env.DB,'user',auth.id,'TL','wallet_bonus');
      const source = await ensureLedgerAccount(c.env.DB,'system','v5-store-welcome','TL','issuance');
      await postLedgerTransaction(c.env.DB,{
        idempotencyKey:welcomeKey,transactionType:'store_welcome_bonus',source:'v5_promotion',
        referenceType:'user',referenceId:String(auth.id),
        description:'스토어 가입 추가 축하금 57,500 TL',
        metadata:{non_redeemable:true,store_welcome:true},
        issuanceStatements:[c.env.DB.prepare('UPDATE v3_economy_balances SET available_atoms=available_atoms+?,version=version+1 WHERE account_id=?')
          .bind(bonusAtoms,source)],
        lines:[{accountId:source,assetCode:'TL',amountAtoms:-bonusAtoms},
          {accountId:destination,assetCode:'TL',amountAtoms:bonusAtoms}]
      });
    }

    } catch (bonusError) {
      console.error('[store-welcome] bonus posting pending for user', auth.id, bonusError);
    }

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
    if(requestKey){
      const previous=await c.env.DB.prepare('SELECT input_hash,result_json FROM v5_sales_channel_requests WHERE request_key=? AND owner_id=?').bind(requestKey,auth.id).first<any>();
      if(previous&&previous.input_hash===inputHash)return c.json({...JSON.parse(previous.result_json),already:true});
    }
    return c.json({ok:false,error:e?.message||'스토어 개설 실패'},500);
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

// Store DJ timetable: one source at a time, central radio otherwise.
// Times are HH:mm in the store's local clock; schedule is explicitly selected by the owner.
router.put('/channels/:id/dj-schedule',async c=>{
  const auth=await authUser(c);
  if(!auth)return c.json({ok:false,error:'인증 필요'},401);
  await ensureCafeTables(c.env.DB);
  const id=c.req.param('id');
  const store=await c.env.DB.prepare('SELECT owner_id FROM cafe_channels WHERE channel_id=? AND status=?').bind(id,'active').first<any>();
  if(!store)return c.json({ok:false,error:'스토어 없음'},404);
  if(Number(store.owner_id)!==auth.id)return c.json({ok:false,error:'권한 없음'},403);
  const body=await c.req.json<any>().catch(()=>({}));
  if(!Array.isArray(body.slots)||body.slots.length>48)return c.json({ok:false,error:'편성표 형식 오류'},400);
  const links=await c.env.DB.prepare('SELECT dj_id,manager_user_id FROM v5_sales_stores WHERE channel_id=?').bind(id).first<any>();
  if(body.slots.length&&!links?.manager_user_id)return c.json({ok:false,error:'계약 매니저 연결이 필요합니다.'},400);
  const normalized:any[]=[];
  for(const slot of body.slots){
    const djId=Number(slot.dj_id);
    const start=String(slot.start||''),end=String(slot.end||'');
    if(!Number.isSafeInteger(djId)||djId<=0||!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(start)||!/^([01]\\d|2[0-3]):[0-5]\\d$/.test(end)||start>=end)
      return c.json({ok:false,error:'DJ 및 방송 시간을 확인하세요.'},400);
    const dj=await c.env.DB.prepare('SELECT id FROM dj_profiles WHERE id=? AND status=?').bind(djId,'active').first<any>();
    if(!dj||djId!==Number(links.dj_id))return c.json({ok:false,error:'계약 매니저가 연결한 DJ만 편성할 수 있습니다.'},403);
    normalized.push({dj_id:djId,start,end});
  }
  normalized.sort((a,b)=>a.start.localeCompare(b.start));
  for(let i=1;i<normalized.length;i++)if(normalized[i].start<normalized[i-1].end)
    return c.json({ok:false,error:'스토어 방송 시간대가 겹칩니다.'},400);
  await c.env.DB.prepare('UPDATE cafe_channels SET schedules=?,updated_at=? WHERE channel_id=?').bind(JSON.stringify(normalized),Date.now(),id).run();
  return c.json({ok:true,channel_id:id,schedules:normalized});
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


// ── 카페 직원 초대·승인 ──
async function ensureCafeStaffTables(db: any) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS cafe_staff_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    invited_by INTEGER NOT NULL,
    approved_by INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(channel_id,user_id)
  )`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS cafe_staff_invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    created_by INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL DEFAULT 10,
    uses INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL
  )`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_cafe_staff_channel_status ON cafe_staff_members(channel_id,status)').run().catch(()=>{});
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_cafe_staff_invite_hash ON cafe_staff_invites(code_hash,status)').run().catch(()=>{});
}
async function cafeCodeHash(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('');
}
async function cafeMemberRole(db: any, channelId: string, userId: number): Promise<'owner'|'staff'|'pending'|'none'> {
  const cafe = await db.prepare('SELECT owner_id FROM cafe_channels WHERE channel_id=?').bind(channelId).first();
  if (!cafe) return 'none';
  if (Number(cafe.owner_id) === userId) return 'owner';
  const member = await db.prepare('SELECT status FROM cafe_staff_members WHERE channel_id=? AND user_id=?').bind(channelId,userId).first();
  return member?.status === 'active' ? 'staff' : member?.status === 'pending' ? 'pending' : 'none';
}

// 대표자: 직원 초대 코드 발급 (7일 유효, 최대 10회 사용)
router.post('/channels/:id/staff/invites', async (c) => {
  const auth = await authUser(c);
  if (!auth) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
  await ensureCafeTables(c.env.DB);
  await ensureCafeStaffTables(c.env.DB);
  const channelId = c.req.param('id');
  const cafe = await c.env.DB.prepare('SELECT owner_id FROM cafe_channels WHERE channel_id=?').bind(channelId).first<any>();
  if (!cafe) return c.json({ok:false,error:'카페 채널을 찾을 수 없습니다.'},404);
  if (Number(cafe.owner_id)!==auth.id) return c.json({ok:false,error:'대표자만 직원을 초대할 수 있습니다.'},403);
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const random=new Uint8Array(8); crypto.getRandomValues(random);
  const code=Array.from(random).map(n=>alphabet[n%alphabet.length]).join('');
  const now=Date.now(), expiresAt=now+7*24*60*60*1000;
  await c.env.DB.prepare('INSERT INTO cafe_staff_invites (channel_id,code_hash,created_by,expires_at,max_uses,uses,status,created_at) VALUES (?,?,?,?,10,0,?,?)')
    .bind(channelId,await cafeCodeHash(code),auth.id,expiresAt,'active',now).run();
  return c.json({ok:true,channel_id:channelId,invite_code:code,expires_at:expiresAt,max_uses:10});
});

// 직원: 대표자가 전달한 초대 코드로 승인 요청
router.post('/staff/join', async (c) => {
  const auth=await authUser(c);
  if(!auth) return c.json({ok:false,error:'먼저 TimeLink에 로그인해주세요.'},401);
  await ensureCafeTables(c.env.DB);
  await ensureCafeStaffTables(c.env.DB);
  const body=await c.req.json<any>().catch(()=>({}));
  const channelId=String(body.channel_id||'').trim().toLowerCase();
  const code=String(body.invite_code||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(!channelId||!/^[A-Z0-9]{8}$/.test(code)) return c.json({ok:false,error:'카페 채널 ID와 8자리 초대 코드를 확인해주세요.'},400);
  const cafe=await c.env.DB.prepare('SELECT channel_id,owner_id,name FROM cafe_channels WHERE channel_id=? AND status=?').bind(channelId,'active').first<any>();
  if(!cafe) return c.json({ok:false,error:'카페 채널을 찾을 수 없습니다.'},404);
  if(Number(cafe.owner_id)===auth.id) return c.json({ok:false,error:'대표자 계정은 직원으로 등록할 수 없습니다.'},400);
  const hash=await cafeCodeHash(code), now=Date.now();
  const invite=await c.env.DB.prepare("SELECT id,created_by,expires_at,max_uses,uses FROM cafe_staff_invites WHERE channel_id=? AND code_hash=? AND status='active' ORDER BY id DESC LIMIT 1")
    .bind(channelId,hash).first<any>();
  if(!invite||Number(invite.expires_at)<now||Number(invite.uses)>=Number(invite.max_uses)) return c.json({ok:false,error:'초대 코드가 올바르지 않거나 만료되었습니다.'},400);
  let member=await c.env.DB.prepare('SELECT id,status FROM cafe_staff_members WHERE channel_id=? AND user_id=?').bind(channelId,auth.id).first<any>();
  if(member && member.status!=='revoked') {
    return c.json({ok:true,channel_id:channelId,cafe_name:cafe.name,staff_status:member.status,message:member.status==='active'?'이미 승인된 직원 계정입니다.':'이미 대표자의 승인을 기다리고 있습니다.'});
  }
  if(member?.status==='revoked') {
    await c.env.DB.prepare("UPDATE cafe_staff_members SET status='pending',invited_by=?,approved_by=NULL,updated_at=? WHERE id=?")
      .bind(Number(invite.created_by),now,member.id).run();
  } else {
    await c.env.DB.prepare("INSERT INTO cafe_staff_members (channel_id,user_id,status,invited_by,created_at,updated_at) VALUES (?,?,'pending',?,?,?)")
      .bind(channelId,auth.id,Number(invite.created_by),now,now).run();
  }
  await c.env.DB.prepare('UPDATE cafe_staff_invites SET uses=uses+1 WHERE id=?').bind(invite.id).run();
  const refreshed=await c.env.DB.prepare('SELECT id,status FROM cafe_staff_members WHERE channel_id=? AND user_id=?').bind(channelId,auth.id).first<any>();
  return c.json({ok:true,channel_id:channelId,cafe_name:cafe.name,staff_status:refreshed?.status||'pending',message:refreshed?.status==='active'?'이미 승인된 직원 계정입니다.':'대표자의 승인을 기다리고 있습니다.'});
});

// 대표자: 직원 목록과 승인 대기 현황
router.get('/channels/:id/staff', async (c) => {
  const auth=await authUser(c);
  if(!auth) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
  await ensureCafeTables(c.env.DB); await ensureCafeStaffTables(c.env.DB);
  const channelId=c.req.param('id');
  const cafe=await c.env.DB.prepare('SELECT owner_id FROM cafe_channels WHERE channel_id=?').bind(channelId).first<any>();
  if(!cafe) return c.json({ok:false,error:'카페 채널을 찾을 수 없습니다.'},404);
  if(Number(cafe.owner_id)!==auth.id) return c.json({ok:false,error:'대표자만 직원 목록을 볼 수 있습니다.'},403);
  const rows=await c.env.DB.prepare("SELECT m.id,m.user_id,m.status,m.created_at,m.updated_at,u.username,u.email FROM cafe_staff_members m LEFT JOIN users u ON u.id=m.user_id WHERE m.channel_id=? ORDER BY CASE m.status WHEN 'pending' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,m.created_at DESC")
    .bind(channelId).all<any>();
  return c.json({ok:true,staff:rows.results||[]});
});

// 대표자: 직원 승인
router.post('/channels/:id/staff/:memberId/approve', async (c) => {
  const auth=await authUser(c);
  if(!auth) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
  await ensureCafeTables(c.env.DB); await ensureCafeStaffTables(c.env.DB);
  const channelId=c.req.param('id'), memberId=Number(c.req.param('memberId'));
  const cafe=await c.env.DB.prepare('SELECT owner_id FROM cafe_channels WHERE channel_id=?').bind(channelId).first<any>();
  if(!cafe) return c.json({ok:false,error:'카페 채널을 찾을 수 없습니다.'},404);
  if(Number(cafe.owner_id)!==auth.id) return c.json({ok:false,error:'대표자만 승인할 수 있습니다.'},403);
  const member=await c.env.DB.prepare("SELECT id FROM cafe_staff_members WHERE id=? AND channel_id=? AND status='pending'").bind(memberId,channelId).first<any>();
  if(!member) return c.json({ok:false,error:'승인 대기 중인 직원을 찾을 수 없습니다.'},404);
  await c.env.DB.prepare("UPDATE cafe_staff_members SET status='active',approved_by=?,updated_at=? WHERE id=? AND channel_id=?")
    .bind(auth.id,Date.now(),memberId,channelId).run();
  return c.json({ok:true,member_id:memberId,status:'active'});
});

// 대표자: 직원 권한 회수
router.delete('/channels/:id/staff/:memberId', async (c) => {
  const auth=await authUser(c);
  if(!auth) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
  await ensureCafeTables(c.env.DB); await ensureCafeStaffTables(c.env.DB);
  const channelId=c.req.param('id'), memberId=Number(c.req.param('memberId'));
  const cafe=await c.env.DB.prepare('SELECT owner_id FROM cafe_channels WHERE channel_id=?').bind(channelId).first<any>();
  if(!cafe) return c.json({ok:false,error:'카페 채널을 찾을 수 없습니다.'},404);
  if(Number(cafe.owner_id)!==auth.id) return c.json({ok:false,error:'대표자만 권한을 회수할 수 있습니다.'},403);
  await c.env.DB.prepare("UPDATE cafe_staff_members SET status='revoked',updated_at=? WHERE id=? AND channel_id=?")
    .bind(Date.now(),memberId,channelId).run();
  return c.json({ok:true,member_id:memberId,status:'revoked'});
});

// 대표자 또는 승인 직원: 카페 방송 운영 권한 확인
router.get('/staff/access/:channelId', async (c) => {
  const auth=await authUser(c);
  if(!auth) return c.json({ok:false,error:'로그인이 필요합니다.'},401);
  await ensureCafeTables(c.env.DB); await ensureCafeStaffTables(c.env.DB);
  const channelId=c.req.param('channelId');
  const cafe=await c.env.DB.prepare('SELECT channel_id,name,owner_id,status,expires_at FROM cafe_channels WHERE channel_id=?').bind(channelId).first<any>();
  if(!cafe) return c.json({ok:false,error:'카페 채널을 찾을 수 없습니다.'},404);
  const role=await cafeMemberRole(c.env.DB,channelId,auth.id);
  const active=String(cafe.status)==='active'&&(!cafe.expires_at||Number(cafe.expires_at)>Date.now());
  const canOperate=active&&(role==='owner'||role==='staff');
  return c.json({ok:true,channel:{channel_id:cafe.channel_id,name:cafe.name,status:cafe.status,expires_at:cafe.expires_at},role,can_operate:canOperate,error:active?undefined:'카페 채널이 비활성 상태이거나 이용 기간이 만료되었습니다.'});
});

// ── GET /api/cafe/channels/:channelId/broadcast — 카페 방송 정보 ──
router.get('/channels/:channelId/broadcast', async (c) => {
  try {
    await ensureCafeTables(c.env.DB);
    const channelId = c.req.param('channelId');
    const cafe = await c.env.DB.prepare(
      'SELECT channel_id, name, owner_id, playlist, schedules, plan, status, expires_at FROM cafe_channels WHERE channel_id=?'
    ).bind(channelId).first<any>();
    if (!cafe) return c.json({ ok: false, error: '카페 없음' }, 404);

    const { results: contracts } = await c.env.DB.prepare(
      "SELECT l.id, l.dj_id, l.status, l.revenue_share_dj, l.revenue_share_cafe, l.revenue_share_platform, p.dj_name, p.is_live, p.live_current_track_id FROM dj_cafe_links l LEFT JOIN dj_profiles p ON p.id = l.dj_id WHERE l.cafe_channel_id=? AND l.status='active'"
    ).bind(channelId).all();

    let activeDj = null;
    let currentTrack = null;
    for (const ct of (contracts || [])) {
      if (ct.is_live === 1) {
        activeDj = { dj_id: ct.dj_id, dj_name: ct.dj_name };
        if (ct.live_current_track_id) {
          currentTrack = await c.env.DB.prepare(
            'SELECT id, title, artist, album, category, duration, cover_url, stream_url, preview_url, file_tl, content_kind, release_mode FROM tl_shares WHERE id=?'
          ).bind(ct.live_current_track_id).first<any>();
        }
        break;
      }
    }

    return c.json({
      ok: true,
      channel: {
        channel_id: cafe.channel_id,
        name: cafe.name,
        playlist: cafe.playlist ? JSON.parse(cafe.playlist) : [],
        schedules: cafe.schedules ? JSON.parse(cafe.schedules) : [],
        plan: cafe.plan,
        status: cafe.status,
        expires_at: cafe.expires_at
      },
      contracts: contracts || [],
      active_dj: activeDj,
      current_track: currentTrack ? {
        id: currentTrack.id, title: currentTrack.title, artist: currentTrack.artist,
        album: currentTrack.album, category: currentTrack.category, duration: currentTrack.duration,
        cover_url: currentTrack.cover_url, stream_url: currentTrack.stream_url || currentTrack.preview_url,
        file_tl: currentTrack.file_tl, content_kind: currentTrack.content_kind, release_mode: currentTrack.release_mode
      } : null
    });
  } catch (e: any) {
    return c.json({ ok: false, error: e?.message || 'broadcast 조회 실패' }, 500);
  }
});

export default router;
