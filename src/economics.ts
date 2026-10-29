import {readDailyMusicAllowance} from './v5-subscription-meter';
import {readContributionEvaluation} from './v5-contribution-store';
import {dailyFreeCatalogue} from './v5-daily-free-policy';
import { Hono } from 'hono';
import { requestListenerCashout } from './v5-cashout';
import { readRewardPolicy } from './v5-reward-policy';
import { completeAdReward, startAdReward } from './v5-ad-reward';
import { verifyToken } from './auth';
import type { Env } from './types';
import { getLedgerWallet, atomsToTl, ensureLedgerAccount, postLedgerTransaction, tlToAtoms } from './economy-ledger';
import { CREATOR_SHARE_RATE, PLATFORM_SHARE_RATE } from './economy-policy';

const eco = new Hono<{ Bindings: Env }>();

// New policy is a separate preview until all verified producers are connected.
eco.get('/daily-free-products',c=>c.json({ok:true,status:'design',purchasable:false,products:dailyFreeCatalogue()}));
eco.get('/daily-free-allowance',async c=>{
  const userId=await authId(c);if(!userId)return c.json({error:'인증 필요'},401);
  return c.json({ok:true,...await readDailyMusicAllowance(c.env.DB,Number(userId))});
});
eco.get('/contribution',async c=>{
  const userId=await authId(c);if(!userId)return c.json({error:'인증 필요'},401);
  return c.json({ok:true,...await readContributionEvaluation(c.env.DB,Number(userId)),policyStatus:'retired',activeRewardPolicy:'v5_reward_policy'});
});

/* ══════════════════════════════════════════════════════
   TL 3분류 경제 시스템
   ─────────────────────────────────────────────────────
   TL_P (구매): 1원=1TL_P, 현금 교환 가능 (플랜A 5%, B 3% 수수료)
   TL_A (광고): 광고 시청 보상, 플랫폼 내 소비만 가능, 교환 불가
   TL_B (보너스): 가입·이벤트 지급, 플랫폼 내 소비만 가능, 교환 불가

   분배 원칙
   ─────────────────────────────────────────────────────
   모든 유효 소비의 기본 분배: 크리에이터 70% / 플랫폼 30%
   TL_P / TL_A / TL_B의 출처별 성격과 지급 버킷은 별도로 유지
   플랜 B의 TLC 채굴 배율 2.0x는 분배 비율과 무관

   POC 기여지수 (최소 0.1, 최대 5.0)
   ─────────────────────────────────────────────────────
   창작 기여  40% : TL_P 소비 누적 기반 재생수
   소비 기여  30% : TL_P 월소비량 / 5,000
   청취 기여  20% : 방송 청취 시간 / 30h
   업로드 기여 10% : 신규 업로드 / 5

   V5 창작자 상생발전 기여제도 (2026-10-24 정책 확정, 실행 연결 전)
   ─────────────────────────────────────────────────────
   적용: TILO 중앙방송에서 권리자별 월간 70% 배분 보상 TL 합계
   누진 공제: 0~100,000 TL 0%; 100,000~500,000 TL 5%;
             500,000~2,000,000 TL 10%; 2,000,000~5,000,000 TL 15%;
             5,000,000 TL 초과 20% (각 구간의 초과분에만 적용)
   순서: TILO 실제 방송초 × 0.3 TL → 70:30 배분 → 월간 누진공제
         → 기존 POC 지수 기반 창작자 현금 환전 가능 비율 적용
   POC: 기존 users.poc_index / TLC 채굴 계산체계 재사용; 별도 점수표 금지
   초기 환전율 제안: POC 0.1~<1:10%, 1~<2:20%, 2~<3:40%,
                    3~<4:60%, 4~5:80% (관리자 확정·조정 필요)
   주의: 국가의 조세가 아닌 계약상 플랫폼 발전기여금.
         사전고지·권리계약 검토·월별 확정·소급변경 금지.
         원장에 공제·잔액·환전·TILO 플랫폼 재원을 각각 기록하고
         내부 TL 회수를 외부 현금 매출로 중복 계상하지 않는다.
         관리자 설정·감사이력·지급준비금 한도·중복환전 방지 필수.
         이 문서화는 공제/환전 로직을 실제 활성화하지 않는다.

   TLC 채굴 (TL_P 기반만)
   ─────────────────────────────────────────────────────
   일일 TLC = (TL_P 월소비 / 30) × 0.08 × POC_index
   월 TLC 하드캡 = TL_P 월소비 × 0.30
   플랜 B 배율 2.0x (하드캡은 동일 적용)
══════════════════════════════════════════════════════ */

async function authId(c: any): Promise<string | null> {
  const token = (c.req.header('Authorization') || '').replace(/^Bearer\s+/, '').trim();
  if (!token) return null;
  try {
    const payload = await verifyToken(token, c.env.JWT_SECRET);
    const userId = Number(payload?.sub || 0);
    if (!Number.isSafeInteger(userId) || userId <= 0) return null;
    const user = await c.env.DB.prepare(
      'SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0'
    ).bind(userId).first();
    return user ? String(userId) : null;
  } catch {
    return null;
  }
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
    const {rules:policy}=await readRewardPolicy(c.env.DB);
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

/**
 * V5 경제원장: 과거 회원가입 보상 누락 복구.
 * 가입 보상액이 그대로 남아 있고 원장 거래 이력이 전혀 없는 회원만 처리한다.
 * 구매 TL로 전환하거나 이미 소비된 보상을 재지급하지 않는다.
 */
export async function reconcilePristineSignupBonus(db: D1Database, user: any, promotionAmount=42500): Promise<void> {
  const entitlement=await db.prepare('SELECT bonus_tl FROM v5_signup_entitlements WHERE user_id=?').bind(user.id).first<any>().catch(()=>null);
  if(entitlement)promotionAmount=Number(entitlement.bonus_tl);
  if(promotionAmount===0)return;
  if(!Number.isSafeInteger(promotionAmount)||promotionAmount<0)throw new Error('INVALID_SIGNUP_BONUS');
  const expected=Number(user.tl_balance);
  // Legacy signup bonus may have been stored in tl_balance only or tl only.
  // Require matching documented 42,500 TL and zero lifetime spending/purchases;
  // the transaction and account checks below still prevent duplicate issuance.
  const legacyTl=Number(user.tl);
  if(!((expected===promotionAmount && (legacyTl===0 || legacyTl===promotionAmount)) ||
       (legacyTl===promotionAmount && (expected===0 || !Number.isFinite(expected)))) ||
     Number(user.total_tl_spent||0)!==0 || Number(user.tl_p_lifetime||0)!==0 ||
     Number(user.tl_p_exchanged||0)!==0) return;
  const owner=String(user.id);
  const activity=await db.prepare(`
    SELECT 1 AS found FROM v3_economy_entries e
    JOIN v3_economy_accounts a ON a.id=e.account_id
    WHERE a.owner_type='user' AND a.owner_id=? LIMIT 1
  `).bind(owner).first<any>();
  if(activity&&!entitlement) return;
  const existing=await getLedgerWallet(db,Number(user.id)) as any[];
  if(!entitlement&&existing.some(a=>a.asset_code==='TL' && (Number(a.available_atoms||0)!==0 || Number(a.held_atoms||0)!==0))) return;
  const key='v5-signup-bonus-legacy-user-'+owner;
  const prior=await db.prepare('SELECT id FROM v3_economy_transactions WHERE idempotency_key=?').bind(key).first<any>();
  if(prior)return;
  const destination=await ensureLedgerAccount(db,'user',owner,'TL','wallet_bonus');
  const source=await ensureLedgerAccount(db,'system','v5-signup-promotion','TL','issuance');
  await postLedgerTransaction(db,{
    idempotencyKey:key,transactionType:'signup_bonus',source:'v5_promotion',
    referenceType:'user',referenceId:owner,
    description:'회원가입 TL_B 지급 기록',
    metadata:{non_redeemable:true,legacy_signup_reconciliation:true},
    issuanceStatements:[db.prepare(
      "UPDATE v3_economy_balances SET available_atoms=available_atoms+?,version=version+1 WHERE account_id=?"
    ).bind(tlToAtoms(promotionAmount),source)],
    lines:[
      {accountId:source,assetCode:'TL',amountAtoms:-tlToAtoms(promotionAmount)},
      {accountId:destination,assetCode:'TL',amountAtoms:tlToAtoms(promotionAmount)}
    ]
  });
}

eco.get('/wallet', async (c) => {
  const userId = await authId(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);
  try {
    await migrateDB(c.env.DB);
    const {rules:policy}=await readRewardPolicy(c.env.DB);
    const user = await c.env.DB.prepare(`
      SELECT id, username, tl, tl_p, tl_a, tl_b,
      tl_balance, tl_locked,
             tl_p_lifetime, tl_p_exchanged,
             tlc_balance, poc_index, plan,
             total_tl_spent, total_tl_earned
      FROM users WHERE id=?
    `).bind(userId).first() as any;
    if (!user) return c.json({ error: '유저 없음' }, 404);

    const tlAsset=await c.env.DB.prepare("SELECT decimals FROM v3_economy_assets WHERE asset_code='TL'").first<any>().catch(()=>null);
    const ledgerReady=Number(tlAsset?.decimals)===4;
    let tlP=0,tlA=0,tlB=0;
    let reconciliationError: string | null = null;
    if(ledgerReady){
      // 복구 실패 시 잔액을 임의로 부풀리지 않는다. 기존 기록은 그대로 유지.
      try { await reconcilePristineSignupBonus(c.env.DB,user); }
      catch(e:any) { reconciliationError=String(e?.message || e || 'unknown error').slice(0,400); console.error('[V5 signup bonus reconciliation]',e); }
      const accounts:any[]=await getLedgerWallet(c.env.DB,Number(userId)) as any[];
      tlP=atomsToTl(accounts.filter(a=>a.asset_code==='TL'&&a.bucket==='wallet_paid').reduce((n,a)=>n+Number(a.available_atoms||0),0));
      tlA=atomsToTl(accounts.filter(a=>a.asset_code==='TL'&&a.bucket==='wallet_ad').reduce((n,a)=>n+Number(a.available_atoms||0),0));
      tlB=atomsToTl(accounts.filter(a=>a.asset_code==='TL'&&a.bucket==='wallet_bonus').reduce((n,a)=>n+Number(a.available_atoms||0),0));
    }else{
      return c.json({error:'V5_WALLET_NOT_READY'},503);
    }
    let reconciliationStatus='not_eligible';
    if(ledgerReady && Number(user.tl_balance)===42500 && Number(user.tl)===42500){
      const owner=String(userId);
      const tx=await c.env.DB.prepare('SELECT id FROM v3_economy_transactions WHERE idempotency_key=?').bind('v5-signup-bonus-legacy-user-'+owner).first();
      const activity=await c.env.DB.prepare("SELECT 1 AS found FROM v3_economy_entries e JOIN v3_economy_accounts a ON a.id=e.account_id WHERE a.owner_type='user' AND a.owner_id=? LIMIT 1").bind(owner).first();
      reconciliationStatus=tx?'already_recorded':activity?'blocked_by_existing_activity':'no_existing_activity';
    }
    const splitTotal=tlP+tlA+tlB;
    const legacyCandidates=[user.tl_balance,user.tl].map((value:any)=>Number(value));
    const legacyTotal=legacyCandidates.find((value:number)=>Number.isFinite(value)&&value>0)??0;
    const authoritativeTotal=ledgerReady?splitTotal:(splitTotal>0?splitTotal:legacyTotal);

    return c.json({
      wallet: {
        tl_p: tlP,         // 구매 TL (교환 가능)
        tl_a: tlA,         // 광고 TL (사용만)
        tl_b: tlB,         // 보너스 TL (사용만)
        tl_balance: authoritativeTotal,
        tl_split_total: splitTotal,
        tl_legacy_balance: Number(user.tl_balance || 0) || 0,
        tl_locked: Number(user.tl_locked || 0),
        tl_total: authoritativeTotal,
        // Read-only V5 ledger diagnostic. No balances or transactions are mutated here.
        ledger_diagnostic: {
          ledger_ready: ledgerReady,
          reconciliation_status: reconciliationError ? 'posting_failed' : reconciliationStatus,
          reconciliation_error: reconciliationError,
          ledger_tl_total: splitTotal,
          legacy_tl_balance: Number(user.tl_balance || 0),
          legacy_tl: Number(user.tl || 0),
          legacy_total: legacyTotal,
          signup_reconciliation_eligible: ((Number(user.tl_balance)===42500 && (Number(user.tl)===0 || Number(user.tl)===42500)) || (Number(user.tl)===42500 && Number(user.tl_balance)===0)) && Number(user.total_tl_spent||0)===0 && Number(user.tl_p_lifetime||0)===0 && Number(user.tl_p_exchanged||0)===0
        },
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
  const userId = await authId(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);

  const body = await c.req.json() as any;
  const { share_id, seconds, tl_spent, tl_type } = body;
  const consume = Math.max(1, Math.floor(tl_spent || seconds || 1));

  try {
    await migrateDB(c.env.DB);
    const {rules:policy}=await readRewardPolicy(c.env.DB);
    const requestedShare=String(share_id||'').trim();
    if(requestedShare){
      let v5=await c.env.DB.prepare("SELECT file_id FROM tl3_v5_releases WHERE share_id=? AND status='sealed' LIMIT 1").bind(requestedShare).first<any>().catch(()=>null);
      let v4=await c.env.DB.prepare("SELECT file_id FROM tl3_spine_v4_releases WHERE share_id=? AND status='sealed' LIMIT 1").bind(requestedShare).first<any>().catch(()=>null);
      let v3=await c.env.DB.prepare("SELECT file_id FROM tl3_releases WHERE share_id=? AND status='released' LIMIT 1").bind(requestedShare).first<any>().catch(()=>null);
      if(/^\d+$/.test(requestedShare)){
        const fileId=Number(requestedShare);
        v5=v5||await c.env.DB.prepare("SELECT file_id FROM tl3_v5_releases WHERE file_id=? AND status='sealed' LIMIT 1").bind(fileId).first<any>().catch(()=>null);
        v4=v4||await c.env.DB.prepare("SELECT file_id FROM tl3_spine_v4_releases WHERE file_id=? AND status='sealed' LIMIT 1").bind(fileId).first<any>().catch(()=>null);
        v3=v3||await c.env.DB.prepare("SELECT file_id FROM tl3_releases WHERE file_id=? AND status='released' LIMIT 1").bind(fileId).first<any>().catch(()=>null);
      }
      if(v5||v4||v3) return c.json({ok:false,code:'TL3_METER_ONLY',error:'TL3 자산은 실제 재생 시간 정산 경로만 사용할 수 있습니다.'},409);
    }

    const user = await c.env.DB.prepare(
      'SELECT tl, tl_p, tl_a, tl_b, plan FROM users WHERE id=?'
    ).bind(userId).first() as any;
    if (!user) return c.json({ error: '유저 없음' }, 404);

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
    let creatorEarnP = 0, creatorEarnA = 0, creatorEarnB = 0;
    let platformEarnP = 0, platformEarnA = 0, platformEarnB = 0;

    const share = await c.env.DB.prepare(
      'SELECT user_id as creator_id FROM tl_shares WHERE id=?'
    ).bind(share_id).first() as any;

    if (share) {
      // TL_P 소비 → 크리에이터에게 TL_P (교환 가능)
      creatorEarnP = Number((consumedP * CREATOR_SHARE_RATE).toFixed(6));
      platformEarnP = Number((consumedP * PLATFORM_SHARE_RATE).toFixed(6));

      // TL_A 소비 → 크리에이터에게 TL_A (비교환)
      creatorEarnA = Number((consumedA * CREATOR_SHARE_RATE).toFixed(6));
      platformEarnA = Number((consumedA * PLATFORM_SHARE_RATE).toFixed(6));

      // TL_B 소비도 공통 7:3 정책 적용: 창작자 70%는 출처 제한을 보존해 TL_A로 지급
      creatorEarnB = Number((consumedB * CREATOR_SHARE_RATE).toFixed(6));
      platformEarnB = Number((consumedB * PLATFORM_SHARE_RATE).toFixed(6));

      if (creatorEarnP > 0 || creatorEarnA > 0 || creatorEarnB > 0) {
        await c.env.DB.prepare(`
          UPDATE users SET
            tl_p = tl_p + ?,
            tl = tl + ?,
            tl_a = tl_a + ?,
            total_tl_earned = total_tl_earned + ?
          WHERE id=?
        `).bind(
          creatorEarnP, creatorEarnP,
          creatorEarnA + creatorEarnB,
          creatorEarnP + creatorEarnA + creatorEarnB,
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
      creator: { tl_p: creatorEarnP, tl_a: creatorEarnA + creatorEarnB },
      platform: { tl_p: platformEarnP, tl_a: platformEarnA, tl_b: platformEarnB },
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
eco.post('/ad-session', async c => {
  const userId=await authId(c);
  if(!userId)return c.json({error:'인증 필요'},401);
  try {
    const body=await c.req.json<any>();
    return c.json({ok:true,...await startAdReward(c.env.DB,Number(userId),String(body.ad_id||''))});
  } catch(e:any){return c.json({error:e.message},400);}
});

eco.post('/ad-reward', async c => {
  const userId=await authId(c);
  if(!userId)return c.json({error:'인증 필요'},401);
  try {
    const body=await c.req.json<any>();
    return c.json(await completeAdReward(c.env.DB,Number(userId),String(body.ad_id||''),String(body.session_id||'')));
  } catch(e:any){return c.json({error:e.message},409);}
});

/* ══════════════════════════════════════════════════════
   POST /api/eco/exchange
   TL_P → 현금 교환 신청 (수수료 차감 후 순액 지급)
   body: { tl_amount }
══════════════════════════════════════════════════════ */
eco.post('/exchange',async c=>{
  const userId=await authId(c);if(!userId)return c.json({error:'인증 필요'},401);
  try{
    await migrateDB(c.env.DB);
    const {rules:policy}=await readRewardPolicy(c.env.DB);
    const body=await c.req.json<any>();
    if(body.kind&&body.kind!=='listener')return c.json({error:'창작자 환전은 별도 기여도 정책 승인 경로를 이용해야 합니다.'},409);
    const user=await c.env.DB.prepare('SELECT plan FROM users WHERE id=?').bind(userId).first<any>();
    return c.json(await requestListenerCashout(c.env.DB,{userId:Number(userId),amountTL:Number(body.tl_amount),
      requestKey:String(c.req.header('Idempotency-Key')||body.request_key||''),plan:user?.plan||'A'}));
  }catch(e:any){return c.json({error:e.message},409);}
});

/* ══════════════════════════════════════════════════════
   POST /api/eco/activity
   활동 보고 + POC 재계산 (신 알고리즘)
   body: { seconds, tl_p_spent, tl_a_spent, tl_b_spent,
           mode, share_id, new_uploads, listen_minutes }
══════════════════════════════════════════════════════ */
/**
 * Development-stage POC calculator. Only server-held evidence participates;
 * client-supplied amounts can never influence this calculation.
 * Shared by preview and mining so payouts cannot use stale client estimates.
 * Financial issuance here is internal TLC ledger only; NOT a TON mint.
 */
async function calculateServerPoc(db:D1Database,userId:string){
  await migrateDB(db);
  const {rules:policy}=await readRewardPolicy(db);
    // 월간 집계 데이터 조회 (POC 계산용)
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;

    const monthlyStats = await db.prepare(`
      SELECT
        SUM(CASE WHEN mode='consume' THEN tl_spent ELSE 0 END) as monthly_tl_p,
        SUM(seconds) as total_seconds,
        COUNT(*) as source_event_count
      FROM poc_logs
      WHERE user_id=? AND created_at >= ?
    `).bind(userId, monthStart).first() as any;

    const shareStats = await db.prepare(`
      SELECT COUNT(*) as play_count
      FROM poc_logs
      WHERE user_id=? AND mode='listen' AND created_at >= ?
    `).bind(userId, monthStart).first() as any;

    // MP3와 TL3 업로드 수 분리 집계 (MP3 = 1, TL3 = 3 가중치)
    const uploadStats = await db.prepare(`
      SELECT 
        COALESCE(SUM(CASE WHEN content_kind='mp3' OR release_mode LIKE 'free_mp3%' THEN 1 ELSE 0 END), 0) as mp3_count,
        COALESCE(SUM(CASE WHEN content_kind='tl3' OR release_mode='tl3' THEN 1 ELSE 0 END), 0) as tl3_count
      FROM tl_shares
      WHERE user_id=? AND created_at >= ?
    `).bind(userId, monthStart + ' 00:00:00').first().catch(() => ({ mp3_count: 0, tl3_count: 0 })) as any;


    // ★ 악보 통계 (신규) — 악보 공유/사용/보기
    const scoreStats = await db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN mode='upload_score' THEN 1 ELSE 0 END), 0) as shares,
        COALESCE(SUM(CASE WHEN mode='score_use' THEN 1 ELSE 0 END), 0) as uses,
        COALESCE(SUM(CASE WHEN mode='score_view' THEN 1 ELSE 0 END), 0) as views
      FROM poc_logs
      WHERE user_id=? AND created_at >= ?
    `).bind(userId, monthStart).first().catch(() => ({ shares: 0, uses: 0, views: 0 })) as any;
    // ── POC 신 알고리즘 ──
    // 요소별 정규화 (각 최대값 기준)
    const monthlyTlP   = Math.max(0,Number(monthlyStats?.monthly_tl_p || 0));
    const monthlyPlays = Number(shareStats?.play_count || 0);
    const monthlyHours = Math.max(0,Number(monthlyStats?.total_seconds || 0)) / 3600;
    // MP3 = 1점, TL3 = 3점 (가중치)
    const mp3Count = Number(uploadStats?.mp3_count || 0);
    const tl3Count = Number(uploadStats?.tl3_count || 0);
    const uploads  = mp3Count * policy.upload_mp3_weight + tl3Count * policy.upload_tl3_weight;

    // 각 요소 점수 (0 ~ 최대값)
    const contentScore = Math.min(policy.content_cap,monthlyPlays/policy.content_target);        // 500회 = 만점
    const spendScore   = Math.min(policy.spend_cap,monthlyTlP/policy.spend_target);         // 5,000 TL_P = 만점
    const listenScore  = Math.min(policy.listen_cap,monthlyHours/policy.listen_target);         // 30시간 = 만점
    const uploadScore  = Math.min(policy.upload_cap,uploads/policy.upload_target);               // 5개 = 만점

    // ★ 악보 기여 점수 (신규)
    const scoreShares = Number(scoreStats?.shares || 0);
    const scoreUses   = Number(scoreStats?.uses || 0);
    const scoreViews  = Number(scoreStats?.views || 0);
    const scoreScore  = Math.min(policy.score_cap,
      scoreShares * policy.score_share +        // 악보 공유 1개 = 0.3
      scoreUses   * policy.score_use +       // 악보 사용 1회 = 0.05
      scoreViews  * policy.score_view        // 악보 보기 1회 = 0.005
    );

    // 가중합 (5요소, 총 100%)
    const rawPoc =
      contentScore * policy.weight_content +      // 40% → 35%
      spendScore   * policy.weight_spend +      // 30% → 25%
      listenScore  * policy.weight_listen +      // 20% → 18%
      uploadScore  * policy.weight_upload +      // 그대로
      scoreScore   * policy.weight_score;       // ★ 신규 12%

    // 하드캡 5.0, 최솟값 0.1
    const pocIndex = Math.min(policy.poc_max,Math.max(policy.poc_min,rawPoc*policy.poc_scale));

    // A legacy preview is not verification; never persist a payout/cashout POC index.

    // ── TLC 채굴 가능량 계산 ──
    const user = await db.prepare(
      'SELECT plan, tl_p_lifetime, tl_p_exchanged FROM users WHERE id=?'
    ).bind(userId).first() as any;

    const userPlan      = user?.plan || 'A';
    const mineMultiplier = userPlan === 'B' ? policy.plan_b_multiplier : 1.0;

    // 일일 채굴량 = (월소비 / 30) × 0.08 × POC × 배율
    const dailyBase = (monthlyTlP / 30) * policy.mining_rate;
    const dailyTLC  = dailyBase * pocIndex * mineMultiplier;

    // 월 하드캡: TL_P 월소비의 30%
    const monthHardCap = monthlyTlP * policy.mining_month_cap;

    return {
      ok: true,
      preview_only:true,policy_source:'server_activity_summary',
      source_event_count:Number(monthlyStats?.source_event_count || 0),
      poc_index: Number(pocIndex.toFixed(3)),
      poc_components: {
        content: Number(contentScore.toFixed(3)),
        spend:   Number(spendScore.toFixed(3)),
        listen:  Number(listenScore.toFixed(3)),
        upload:  Number(uploadScore.toFixed(3)),
        score:   Number(scoreScore.toFixed(3)),
      },
      tlc_mining: {
        daily_max: Number(Math.min(dailyTLC,monthHardCap/30).toFixed(9)),
        monthly_hard_cap: Number(monthHardCap.toFixed(4)),
        monthly_eligible_tl_p: Number(monthlyTlP.toFixed(4)),
        theoretical_daily_max: Number(dailyTLC.toFixed(9)),
        plan_multiplier: mineMultiplier,
      }
    };
}

eco.post('/activity', async (c) => {
  const userId=await authId(c);
  if(!userId)return c.json({ok:false,error:'인증 필요'},401);
  const body=await c.req.json().catch(()=>({})) as any;
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==0)
    return c.json({ok:false,code:'CLIENT_REPORTED_POC_DISABLED',
      error:'소비·청취·업로드 증빙은 서버 활동 기록에서만 계산합니다.'},403);
  try{return c.json(await calculateServerPoc(c.env.DB,userId));}
  catch(error:any){return c.json({ok:false,error:String(error.message||error)},503);}
});

/* ══════════════════════════════════════════════════════
   GET /api/eco/mining-history
   로그인 사용자의 TLC 채굴 이력 (대시보드 읽기 전용)
══════════════════════════════════════════════════════ */
eco.get('/mining-history', async (c) => {
  const userId = await authId(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);
  try {
    await migrateDB(c.env.DB);
    const {rules:policy}=await readRewardPolicy(c.env.DB);
    const result = await c.env.DB.prepare(`
      SELECT tl_p_base, poc_index, plan, multiplier, tlc_mined, created_at
      FROM tlc_mining_v2
      WHERE user_id=?
      ORDER BY created_at DESC
      LIMIT 20
    `).bind(userId).all();
    return c.json({ ok: true, history: result.results || [] });
  } catch (e: any) {
    return c.json({ ok: false, error: e.message }, 500);
  }
});

/* ══════════════════════════════════════════════════════
   POST /api/eco/mine-tlc
   TLC 채굴 확정 (하루 1회, 하드캡 적용)
══════════════════════════════════════════════════════ */
eco.post('/mine-tlc', async (c) => {
  const userId=await authId(c);
  if(!userId)return c.json({ok:false,error:'인증 필요',code:'AUTH_REQUIRED'},401);
  // Never trust the caller's requested amount: the server independently
  // calculates a day's TLC from verified-on-server POC activity and policies.
  const body=await c.req.json().catch(()=>({})) as any;
  if(!body||typeof body!=='object'||Array.isArray(body)||
    Object.keys(body).some(key=>key!=='tlc_amount'))
    return c.json({ok:false,code:'INVALID_MINING_REQUEST'},400);
  if(body.tlc_amount!==undefined&&(!Number.isFinite(body.tlc_amount)||body.tlc_amount<0))
    return c.json({ok:false,code:'INVALID_MINING_REQUEST'},400);
  try{
    const db=c.env.DB;
    const date=new Date().toISOString().slice(0,10);
    const prior=await db.prepare("SELECT id,tlc_mined FROM tlc_mining_v2 WHERE user_id=? AND DATE(created_at)=? LIMIT 1")
      .bind(userId,date).first<any>();
    if(prior)return c.json({ok:false,code:'ALREADY_MINED_TODAY',error:'오늘 TLC 채굴은 이미 완료되었습니다.',already_mined:Number(prior.tlc_mined||0)},409);
    const v3Prior=await db.prepare('SELECT id,minted_atoms FROM v3_tlc_mining_records WHERE user_id=? AND period_date=? LIMIT 1')
      .bind(userId,date).first<any>();
    if(v3Prior)return c.json({ok:false,code:'ALREADY_MINED_TODAY',error:'오늘 TLC 채굴은 이미 완료되었습니다.',already_mined:Number(v3Prior.minted_atoms)/1e9},409);
    const preview=await calculateServerPoc(db,userId);
    const daily=Number(preview.tlc_mining.daily_max||0);
    const amountAtoms=Math.round(daily*1e9);
    if(!Number.isSafeInteger(amountAtoms)||amountAtoms<10000000)
      return c.json({ok:false,code:'NO_TLC_MINEABLE',error:'오늘 채굴 가능한 TLC가 없습니다.',poc_index:preview.poc_index},400);
    const amount=amountAtoms/1e9;
    const plan=await db.prepare('SELECT plan FROM users WHERE id=?').bind(userId).first<any>();
    const planCode=plan?.plan==='B'?'B':'A';
    const userAccount=await ensureLedgerAccount(db,'user',userId,'TLC','wallet');
    const systemAccount=await ensureLedgerAccount(db,'system','v5-dev-mining','TLC','issuance');
    const snapshotId=crypto.randomUUID(),miningId=crypto.randomUUID();
    const receiptKey='v5-tlc-day:'+userId+':'+date;
    const snapshot={
      activity:preview.poc_components,policy:'manual',month:date.slice(0,7),
      testStage:'prelaunch',score:preview.poc_index
    };
    const statements=[
      db.prepare('INSERT INTO v3_poc_snapshots(id,user_id,period_start,period_end,poc_index,components_json,formula_version,source_event_count) VALUES(?,?,?,?,?,?,?,?)')
        .bind(snapshotId,userId,date.slice(0,7)+'-01',date,Math.max(0.1,Math.min(5,Number(preview.poc_index))),JSON.stringify(snapshot),'server-activity-v1',Number(preview.source_event_count||0)),
      db.prepare("INSERT INTO v3_tlc_mining_records(id,user_id,idempotency_key,period_date,poc_snapshot_id,eligible_tl_spend_atoms,poc_index,plan_code,multiplier,requested_atoms,minted_atoms,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,'posted')")
         .bind(miningId,userId,receiptKey,date,snapshotId,Math.round(Number(preview.tlc_mining.monthly_eligible_tl_p||0)*10000),Number(preview.poc_index),planCode,Number(preview.tlc_mining.plan_multiplier||1),amountAtoms,amountAtoms),
      db.prepare('UPDATE users SET tlc_balance=COALESCE(tlc_balance,0)+? WHERE id=?')
        .bind(amount,userId),
      db.prepare("INSERT INTO tlc_mining_v2(user_id,tl_p_base,poc_index,plan,multiplier,tlc_mined) VALUES(?,?,?,?,?,?)")
        .bind(userId,Number(preview.tlc_mining.monthly_eligible_tl_p||0),Number(preview.poc_index),planCode,Number(preview.tlc_mining.plan_multiplier||1),amount)
    ];
    const posted=await postLedgerTransaction(db,{
      idempotencyKey:receiptKey,transactionType:'tlc_development_mining',source:'server_poc_v1',
      referenceType:'mining_day',referenceId:date,actorUserId:userId,
      description:'개발 단계 TLC 내부 원장 채굴 (블록체인 발행 아님)',
      metadata:{date,poc_index:preview.poc_index,development_only:true,amount_tlc:amount},
      issuanceStatements:[db.prepare('UPDATE v3_economy_balances SET available_atoms=available_atoms+?,version=version+1 WHERE account_id=?')
        .bind(amountAtoms,systemAccount)],
      lines:[{accountId:systemAccount,assetCode:'TLC',amountAtoms:-amountAtoms},
        {accountId:userAccount,assetCode:'TLC',amountAtoms:amountAtoms}],
      atomicStatements:statements
    });
    if(posted.replayed)return c.json({ok:false,code:'ALREADY_MINED_TODAY',error:'오늘 TLC 채굴은 이미 완료되었습니다.'},409);
    const updated=await db.prepare('SELECT tlc_balance FROM users WHERE id=?').bind(userId).first<any>();
    return c.json({ok:true,mined:amount,tlc_total:Number(updated?.tlc_balance||0),
      today_total:amount,daily_max:daily,poc_index:preview.poc_index,
      plan_multiplier:Number(preview.tlc_mining.plan_multiplier||1),
      development_only:true,ledger_receipt:posted.id,blockchain_minted:false});
  }catch(error:any){
    const message=String(error.message||error);
    if(/UNIQUE constraint failed|Idempotency key|v3_tlc_mining_records/.test(message))
      return c.json({ok:false,code:'ALREADY_MINED_TODAY',error:'동일 날짜의 채굴 기록이 존재합니다. 중복 지급하지 않았습니다.'},409);
    console.error('[V5_MINING_POST]',message);
    return c.json({ok:false,code:'TLC_MINING_POST_FAILED',error:'채굴 원장 저장에 실패했습니다. 잔액과 기록을 확인해주세요.'},503);
  }
});

/* ══════════════════════════════════════════════════════
   POST /api/eco/set-plan
   크리에이터 플랜 변경 (A ↔ B)
══════════════════════════════════════════════════════ */
eco.post('/set-plan', async (c) => {
  const userId = await authId(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);

  const { plan } = await c.req.json() as any;
  if (!['A', 'B'].includes(plan)) return c.json({ error: '플랜은 A 또는 B' }, 400);

  try {
    await migrateDB(c.env.DB);
    const {rules:policy}=await readRewardPolicy(c.env.DB);
    await c.env.DB.prepare('UPDATE users SET plan=? WHERE id=?').bind(plan, userId).run();
    return c.json({
      ok: true, plan,
      note: plan === 'A'
        ? '플랜A: 창작자 배분 70%, 교환수수료 5%'
        : '플랜B: 창작자 배분 70%, TLC 2배 채굴, 교환수수료 3%'
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
  const userId = await authId(c);
  if (!userId) return c.json({ error: '인증 필요' }, 401);

  const { amount_krw } = await c.req.json() as any;
  if (!amount_krw || amount_krw < 100) return c.json({ error: '최소 100원' }, 400);

  try {
    await migrateDB(c.env.DB);
    const {rules:policy}=await readRewardPolicy(c.env.DB);
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
    const {rules:policy}=await readRewardPolicy(c.env.DB);
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
