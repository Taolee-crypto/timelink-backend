import { Hono } from 'hono';
import { authMiddleware } from '../middleware';
import type { Env, User } from '../types';
import { ensureLedgerAccount, getLedgerHistory, getLedgerWallet, postLedgerTransaction, chargeTrackPool, tlToAtoms, atomsToTl, TL_ATOMS_PER_TL } from '../economy-ledger';

const router = new Hono<{ Bindings: Env; Variables: { user: User } }>();
router.use('*', authMiddleware);
router.use('*', async (c, next) => {
  const schema = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name LIKE 'v3_%'"
  ).first<{ count: number }>();
  if (Number(schema?.count || 0) < 9) {
    return c.json({
      ok: false,
      code: 'V3_LEDGER_NOT_INITIALIZED',
      error: 'V3 economy migration has not been applied to this database'
    }, 503);
  }
  const tlAsset = await c.env.DB.prepare("SELECT decimals FROM v3_economy_assets WHERE asset_code='TL'").first<{decimals:number}>();
  if (Number(tlAsset?.decimals) !== 4) {
    return c.json({ok:false,code:'V3_TL_ATOM_SCALE_NOT_READY',error:'TL 정밀도 마이그레이션(0012)이 아직 적용되지 않았습니다.'},503);
  }
  await next();
});

// Canonical V3 wallet response. Track pools are deliberately excluded from wallet total.
router.get('/wallet', async (c) => {
  const user = c.get('user');
  const accounts:any[] = await getLedgerWallet(c.env.DB, user.id) as any[];
  const amount = (bucket:string) => atomsToTl(accounts
    .filter((a:any) => a.asset_code === 'TL' && a.bucket === bucket)
    .reduce((sum:number,a:any) => sum + Number(a.available_atoms || 0), 0));
  const tlP = amount('wallet_paid');
  const tlA = amount('wallet_ad');
  const tlB = amount('wallet_bonus');
  const trackPoolMap = new Map<string, any>();
  for (const account of accounts) {
    if (account.asset_code !== 'TL') continue;
    const match = String(account.bucket || '').match(/^track_pool:([^:]+):(paid|ad|bonus|legacy)$/);
    if (!match) continue;
    const shareId = match[1], source = match[2];
    const pool = trackPoolMap.get(shareId) || {
      share_id: shareId, available_tl: 0, legacy_tl: 0, held_tl: 0,
      by_source: { paid: 0, ad: 0, bonus: 0, legacy: 0 }
    };
    const available = Number(account.available_atoms || 0);
    if(source==='legacy') pool.legacy_tl += atomsToTl(available);
    else pool.available_tl += atomsToTl(available);
    pool.held_tl += atomsToTl(Number(account.held_atoms || 0));
    pool.by_source[source] += atomsToTl(available);
    trackPoolMap.set(shareId, pool);
  }
  const trackPools = [...trackPoolMap.values()];
  const walletInitialized = accounts.some((a:any) =>
    a.asset_code === 'TL' && ['wallet_paid','wallet_ad','wallet_bonus'].includes(String(a.bucket))
  );
  return c.json({
    ok: true,
    ledger_version: 3,
    migration_state: walletInitialized ? 'wallet_initialized' : 'not_yet_migrated',
    wallet: {
      tl_p: tlP,
      tl_a: tlA,
      tl_b: tlB,
      tl_total: tlP + tlA + tlB
    },
    track_pools: trackPools,
    other_accounts: accounts.filter((a:any) =>
      !(a.asset_code === 'TL' &&
        (['wallet_paid','wallet_ad','wallet_bonus'].includes(String(a.bucket)) ||
         /^track_pool:[^:]+:(paid|ad|bonus|legacy)$/.test(String(a.bucket || ''))))
    ),
    tl_atom_scale: TL_ATOMS_PER_TL,
    accounts
  });
});


router.post('/tracks/:shareId/charge', async (c) => {
  const user = c.get('user');
  const shareId = String(c.req.param('shareId') || '').trim();
  const body = await c.req.json<any>().catch(() => ({}));
  const amountTl = Number(body.amount_tl ?? body.amount_atoms);
  const idempotencyKey = String(c.req.header('Idempotency-Key') || '').trim();
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(shareId) ||
      !Number.isSafeInteger(amountTl) || amountTl <= 0 ||
      !idempotencyKey || idempotencyKey.length > 200) {
    return c.json({ok:false,error:'곡 식별자, 정수 충전 TL, Idempotency-Key가 필요합니다.'},400);
  }
  const release = await c.env.DB.prepare(`
    SELECT v.file_id FROM tl3_v5_releases v
    JOIN tl_files f ON f.id=v.file_id
    WHERE v.share_id=? AND v.status='sealed' AND f.shared=1
      AND COALESCE(f.revenue_held,0)=0 LIMIT 1
  `).bind(shareId).first().catch(() => null)
    || await c.env.DB.prepare(`
      SELECT v.file_id FROM tl3_spine_v4_releases v
      JOIN tl_files f ON f.id=v.file_id
      WHERE v.share_id=? AND v.status='sealed' AND f.shared=1
        AND COALESCE(f.revenue_held,0)=0 LIMIT 1
    `).bind(shareId).first().catch(() => null)
    || await c.env.DB.prepare(`
      SELECT r.file_id FROM tl3_releases r
      JOIN tl_files f ON f.id=r.file_id
      WHERE r.share_id=? AND r.status='released' AND f.shared=1
        AND COALESCE(f.revenue_held,0)=0 LIMIT 1
    `).bind(shareId).first().catch(() => null);
  if (!release) return c.json({ok:false,error:'공개된 TL3 자산을 찾지 못했습니다.'},404);
  try {
    const amountAtoms=tlToAtoms(amountTl);
    const posted=await chargeTrackPool(c.env.DB,user.id,shareId,amountAtoms,idempotencyKey);
    const accounts:any[]=await getLedgerWallet(c.env.DB,user.id) as any[];
    const wallet={
      tl_p:atomsToTl(accounts.filter(a=>a.bucket==='wallet_paid').reduce((n,a)=>n+Number(a.available_atoms||0),0)),
      tl_a:atomsToTl(accounts.filter(a=>a.bucket==='wallet_ad').reduce((n,a)=>n+Number(a.available_atoms||0),0)),
      tl_b:atomsToTl(accounts.filter(a=>a.bucket==='wallet_bonus').reduce((n,a)=>n+Number(a.available_atoms||0),0))
    };
    const poolAtoms=accounts.filter(a=>['paid','ad','bonus'].some(source=>a.bucket==='track_pool:'+shareId+':'+source))
      .reduce((n,a)=>n+Number(a.available_atoms||0),0);
    return c.json({
      ok:true,replayed:posted.replayed,amount_tl:atomsToTl(amountAtoms),amount_atoms:amountAtoms,
      wallet:{...wallet,tl_total:wallet.tl_p+wallet.tl_a+wallet.tl_b},
      track_pool_tl:atomsToTl(poolAtoms),tl_atom_scale:TL_ATOMS_PER_TL
    });
  } catch (e:any) {
    if(String(e?.message||'').includes('INSUFFICIENT_TL')) {
      const accounts:any[]=await getLedgerWallet(c.env.DB,user.id) as any[];
      const availableAtoms=accounts.filter(a=>['wallet_paid','wallet_ad','wallet_bonus'].includes(String(a.bucket)))
        .reduce((n,a)=>n+Number(a.available_atoms||0),0);
      return c.json({ok:false,code:'INSUFFICIENT_TL',required_tl:amountTl,available_tl:atomsToTl(availableAtoms)},402);
    }
    return c.json({ok:false,error:e?.message || '곡 전용 TL 충전에 실패했습니다.'},409);
  }
});

router.get('/history', async (c) => {
  const user = c.get('user');
  const limit = Number(c.req.query('limit') || 50);
  const offset = Number(c.req.query('offset') || 0);
  if (!Number.isFinite(limit) || !Number.isFinite(offset)) {
    return c.json({ ok: false, error: 'Invalid pagination' }, 400);
  }
  const entries = await getLedgerHistory(c.env.DB, user.id, limit, offset);
  return c.json({ ok: true, entries });
});

router.get('/poc/current', async (c) => {
  const user = c.get('user');
  const snapshot = await c.env.DB.prepare(`
    SELECT id, period_start, period_end, poc_index, components_json,
           formula_version, source_event_count, calculated_at
    FROM v3_poc_snapshots
    WHERE user_id=?
    ORDER BY period_end DESC, calculated_at DESC
    LIMIT 1
  `).bind(String(user.id)).first();
  return c.json({ ok: true, snapshot: snapshot || null });
});

router.get('/mining/history', async (c) => {
  const user = c.get('user');
  const rows = await c.env.DB.prepare(`
    SELECT id, period_date, eligible_tl_spend_atoms, poc_index, plan_code,
           multiplier, requested_atoms, minted_atoms, status, chain_tx_hash, created_at
    FROM v3_tlc_mining_records
    WHERE user_id=?
    ORDER BY period_date DESC
    LIMIT 100
  `).bind(String(user.id)).all();
  return c.json({ ok: true, records: rows.results || [] });
});

const LEGACY_PREVIEW_TABLES = {
  tl_files: {
    fields: ['id', 'title', 'file_tl', 'max_file_tl', 'revenue', 'hold_revenue', 'revenue_held', 'revenue_started_at', 'auth_status', 'shared', 'shared_to_shareplace', 'pulse', 'play_count', 'created_at', 'updated_at'],
    interpretation: 'file_tl, revenue, and hold_revenue are separate legacy fields; none is automatically treated as a payable balance.'
  },
  tl_shares: {
    fields: ['id', 'title', 'artist', 'file_tl', 'creator_earned', 'pulse', 'plan', 'release_mode', 'content_kind', 'created_at'],
    interpretation: 'SharePlace content metadata and file balance; this table is not a creator settlement ledger.'
  },
  tl_user_files: {
    fields: ['id', 'share_id', 'tl_balance', 'total_charged', 'total_consumed', 'last_played', 'created_at', 'updated_at'],
    interpretation: 'Per-user, per-SharePlace TL allocation and consumption record; it is separate from the global wallet balance.'
  },
  tl_exchanges: {
    fields: ['id', 'tl_amount', 'fee_pct', 'fee_tl', 'net_tl', 'status', 'created_at'],
    interpretation: 'Legacy TL exchange request evidence; status determines whether the request completed.'
  },
  tl_payments: {
    fields: ['id', 'method', 'amount_krw', 'tl_granted', 'bonus_tl', 'status', 'created_at'],
    interpretation: 'Legacy recharge/payment evidence; provider payment identifiers are intentionally excluded.'
  },
  tl3_releases: {
    fields: ['id', 'file_id', 'user_id', 'title', 'artist', 'price_tl', 'status', 'duration_ms', 'segment_count', 'created_at', 'updated_at', 'share_id'],
    interpretation: 'TL3 release metadata and publication state; cryptographic keys, salts, token roots, and private payload fields are deliberately excluded.'
  },
  transactions: {
    fields: ['id', 'file_id', 'tx_type', 'amount', 'balance_after', 'counterpart_user_id', 'note', 'created_at'],
    interpretation: 'Historical transaction evidence; amount must be interpreted together with tx_type and counterpart.'
  },
  play_events: {
    fields: ['id', 'file_id', 'tl_deducted', 'revenue_credited', 'file_tl_after', 'play_duration_seconds', 'car_mode', 'created_at'],
    interpretation: 'Playback evidence; revenue_credited is a recorded event value, not a substitute for current creator balance.'
  },
  poc_events: {
    fields: ['id', 'delta', 'poc_after', 'reason', 'created_at'],
    interpretation: 'Legacy POC evidence; POC is not TL or TLC.'
  },
  tlc_mining_logs: {
    fields: ['id', 'tlc_mined', 'poc_index', 'created_at'],
    interpretation: 'Legacy TLC mining log; a local record is not proof of a confirmed on-chain mint.'
  },
  poc_logs: {
    fields: ['id', 'mode', 'seconds', 'tl_spent', 'poc_gained', 'created_at'],
    interpretation: 'Legacy contribution log; POC is not TL or TLC.'
  },
  tlc_mining_v2: {
    fields: ['id', 'tl_p_base', 'poc_index', 'plan', 'multiplier', 'tlc_mined', 'created_at'],
    interpretation: 'Legacy mining calculation record; a database record alone does not prove an on-chain mint.'
  }
} as const;

type LegacyPreviewTable = keyof typeof LEGACY_PREVIEW_TABLES;

/**
 * Return a bounded, user-scoped evidence sample from an allowlisted legacy table.
 * Table and column identifiers come only from the constants above and PRAGMA metadata.
 * No aggregate, conversion, credit, or mutation is performed.
 */
async function readLegacyEvidence(
  db: D1Database,
  table: LegacyPreviewTable,
  userId: number
): Promise<Record<string, unknown>> {
  const definition = LEGACY_PREVIEW_TABLES[table];
  const schema = await db.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
  const available = new Set((schema.results || []).map((column) => column.name));
  if (!available.size) {
    return { available: false, reason: 'table_missing', rows: [] };
  }

  const selected = definition.fields.filter((field) => available.has(field));
  if (!available.has('id')) {
    return { available: false, reason: 'primary_key_unavailable', selected_columns: selected, rows: [] };
  }

  let where = '';
  let values: (string | number)[] = [];
  if (table === 'play_events') {
    if (!available.has('file_id')) {
      return { available: false, reason: 'file_reference_unavailable', selected_columns: selected, rows: [] };
    }
    where = 'file_id IN (SELECT id FROM tl_files WHERE user_id=?)';
    values = [userId];
  } else if (table === 'transactions' && available.has('user_id')) {
    where = available.has('counterpart_user_id')
      ? '(user_id=? OR counterpart_user_id=?)'
      : 'user_id=?';
    values = available.has('counterpart_user_id') ? [userId, userId] : [userId];
  } else if (available.has('user_id')) {
    where = 'CAST(user_id AS TEXT)=?';
    values = [String(userId)];
  } else {
    return { available: false, reason: 'user_scope_unavailable', selected_columns: selected, rows: [] };
  }

  const projection = selected.map((field) => '"' + field + '"').join(', ');
  const rows = await db.prepare(
    `SELECT ${projection} FROM "${table}" WHERE ${where} ORDER BY id DESC LIMIT 100`
  ).bind(...values).all();

  return {
    available: true,
    selected_columns: selected,
    row_limit: 100,
    rows: rows.results || [],
    interpretation: definition.interpretation
  };
}

/**
 * Read-only legacy reconciliation preview.
 * Every source is reported independently; nothing is summed, imported, or credited.
 */
router.get('/reconciliation/preview', async (c) => {
  const user = c.get('user');
  const schema = await c.env.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>();
  const available = new Set((schema.results || []).map((column) => column.name));
  const candidates = [
    'tl', 'tl_balance', 'tl_locked', 'tl_p', 'tl_a', 'tl_b', 'tlc', 'tlc_balance',
    'tl_p_lifetime', 'tl_p_exchanged', 'total_tl_spent',
    'total_tl_earned', 'total_tl_exchanged', 'poc_index'
  ];
  const selected = candidates.filter((column) => available.has(column));
  if (!available.has('id') || selected.length === 0) {
    return c.json({ ok: false, error: 'Legacy users balance schema is unavailable' }, 503);
  }

  const projection = selected.map((column) => '"' + column + '"').join(', ');
  const legacy = await c.env.DB.prepare(
    `SELECT ${projection} FROM users WHERE id=? LIMIT 1`
  ).bind(user.id).first<Record<string, unknown>>();
  if (!legacy) return c.json({ ok: false, error: 'User not found' }, 404);

  const ledger = await getLedgerWallet(c.env.DB, user.id);
  const legacySources = {} as Record<string, Record<string, unknown>>;
  const tables = Object.keys(LEGACY_PREVIEW_TABLES) as LegacyPreviewTable[];
  const evidence = await Promise.all(
    tables.map(async (table) => [table, await readLegacyEvidence(c.env.DB, table, user.id)] as const)
  );
  for (const [table, result] of evidence) legacySources[table] = result;

  return c.json({
    ok: true,
    read_only: true,
    migration_state: ledger.length ? 'ledger_initialized' : 'legacy_only',
    legacy_fields: legacy,
    detected_columns: selected,
    v3_accounts: ledger,
    legacy_sources: legacySources,
    reconciliation: {
      status: 'not_imported',
      automatic_import: false,
      rule: 'Each legacy field and source record is reported independently. No fields are added together, converted, or credited.',
      review_required: true
    }
  });
});


async function requireLedgerAdmin(db: D1Database, userId: number): Promise<boolean> {
  const row = await db.prepare('SELECT role FROM users WHERE id=?').bind(userId).first<{role:string}>();
  return String(row?.role || '').toLowerCase() === 'admin';
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const OPENING_BUCKET = /^(wallet_paid|wallet_ad|wallet_bonus|track_pool:[A-Za-z0-9_-]{1,120}:(paid|ad|bonus|legacy))$/;

// Admin-only, read-only legacy balance inventory. Values are never combined.
router.get('/admin/reconciliation/users', async (c) => {
  const actor = c.get('user');
  if (!await requireLedgerAdmin(c.env.DB, actor.id)) return c.json({ok:false,error:'관리자 권한 필요'},403);
  const columns = await c.env.DB.prepare('PRAGMA table_info(users)').all<{name:string}>();
  const available = new Set((columns.results || []).map((x) => x.name));
  const wanted = ['id','username','tl','tl_balance','tl_locked','tl_p','tl_a','tl_b','tl_p_lifetime','tl_p_exchanged','tlc_balance','total_tl_earned','total_tl_exchanged'];
  const selected = wanted.filter((x) => available.has(x));
  if (!selected.includes('id')) return c.json({ok:false,error:'users schema unavailable'},503);
  const limit = Math.max(1, Math.min(200, Math.floor(Number(c.req.query('limit') || 100))));
  const offset = Math.max(0, Math.floor(Number(c.req.query('offset') || 0)));
  const q = String(c.req.query('q') || '').trim().slice(0,80);
  const projection = selected.map((x) => '"' + x + '"').join(',');
  const where = q ? 'WHERE CAST(id AS TEXT)=? OR username LIKE ?' : '';
  const binds = q ? [q, '%' + q + '%', limit, offset] : [limit, offset];
  const rows = await c.env.DB.prepare(`SELECT ${projection} FROM users ${where} ORDER BY id LIMIT ? OFFSET ?`).bind(...binds).all();
  return c.json({ok:true,read_only:true,columns:selected,users:rows.results||[],limit,offset,automatic_import:false});
});

// Create a draft only. This endpoint does not credit any account.
router.post('/admin/opening-batches', async (c) => {
  const actor = c.get('user');
  if (!await requireLedgerAdmin(c.env.DB, actor.id)) return c.json({ok:false,error:'관리자 권한 필요'},403);
  const body = await c.req.json<any>().catch(() => ({}));
  const reason = String(body.reason || '').trim().slice(0,500);
  const evidenceRef = String(body.evidence_ref || '').trim().slice(0,500);
  const items = Array.isArray(body.items) ? body.items : [];
  if (!reason || !evidenceRef || !items.length || items.length > 500) {
    return c.json({ok:false,error:'사유, 증빙 참조, 1~500개 항목이 필요합니다.'},400);
  }
  const normalized:any[] = [];
  for (const item of items) {
    const userId = Number(item.user_id);
    const amount = Number(item.amount_atoms);
    const bucket = String(item.bucket || '').trim();
    const sourceTable = String(item.source_table || '').trim().slice(0,80);
    const sourceRowId = String(item.source_row_id || '').trim().slice(0,120);
    const sourceField = String(item.source_field || '').trim().slice(0,80);
    const sourceChecksum = String(item.source_checksum || '').trim().slice(0,128);
    const evidenceNote = String(item.evidence_note || '').trim().slice(0,500);
    if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(amount) || amount <= 0 ||
        !OPENING_BUCKET.test(bucket) || !sourceTable || !sourceRowId || !sourceField ||
        !sourceChecksum || !evidenceNote) {
      return c.json({ok:false,error:'각 항목의 사용자, 정수 TL, 허용 bucket, 원천 위치와 증빙이 필요합니다.'},400);
    }
    const exists = await c.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(userId).first();
    if (!exists) return c.json({ok:false,error:'존재하지 않는 사용자 ID가 포함되어 있습니다.'},404);
    normalized.push({user_id:String(userId),bucket,amount_atoms:amount,source_table:sourceTable,source_row_id:sourceRowId,source_field:sourceField,source_checksum:sourceChecksum,evidence_note:evidenceNote});
  }
  const canonical = JSON.stringify(normalized.slice().sort((a,b) =>
    (a.user_id+a.bucket+a.source_table+a.source_row_id+a.source_field).localeCompare(b.user_id+b.bucket+b.source_table+b.source_row_id+b.source_field)
  ));
  const checksum = await sha256Hex(canonical);
  const batchId = crypto.randomUUID();
  const statements:D1PreparedStatement[] = [
    c.env.DB.prepare(`INSERT INTO v3_economy_opening_batches
      (id,status,created_by,reason,evidence_ref,item_count,checksum)
      VALUES (?,'draft',?,?,?,?,?)`).bind(batchId,String(actor.id),reason,evidenceRef,normalized.length,checksum)
  ];
  for (const item of normalized) {
    statements.push(c.env.DB.prepare(`INSERT INTO v3_economy_opening_items
      (id,batch_id,user_id,bucket,amount_atoms,source_table,source_row_id,source_field,source_checksum,evidence_note)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).bind(
        crypto.randomUUID(),batchId,item.user_id,item.bucket,item.amount_atoms,item.source_table,
        item.source_row_id,item.source_field,item.source_checksum,item.evidence_note
      ));
  }
  try {
    await c.env.DB.batch(statements);
    return c.json({ok:true,batch_id:batchId,status:'draft',item_count:normalized.length,checksum,posted:false},201);
  } catch (e:any) {
    return c.json({ok:false,error:e?.message || '초기 잔액 입력 초안 생성 실패'},409);
  }
});

// Approval is explicit and separate from data entry.
router.post('/admin/opening-batches/:id/approve', async (c) => {
  const actor = c.get('user');
  if (!await requireLedgerAdmin(c.env.DB, actor.id)) return c.json({ok:false,error:'관리자 권한 필요'},403);
  const id = c.req.param('id');
  const result = await c.env.DB.prepare(`UPDATE v3_economy_opening_batches
    SET status='approved',approved_by=?,approved_at=datetime('now')
    WHERE id=? AND status='draft'`).bind(String(actor.id),id).run();
  if (Number(result.meta?.changes || 0) !== 1) return c.json({ok:false,error:'승인 가능한 초안을 찾지 못했습니다.'},409);
  return c.json({ok:true,batch_id:id,status:'approved'});
});

// Post approved items one by one with deterministic idempotency keys.
// Re-running after a partial failure is safe: already-posted ledger transactions replay.
router.post('/admin/opening-batches/:id/post', async (c) => {
  const actor = c.get('user');
  if (!await requireLedgerAdmin(c.env.DB, actor.id)) return c.json({ok:false,error:'관리자 권한 필요'},403);
  const id = c.req.param('id');
  const batch = await c.env.DB.prepare('SELECT * FROM v3_economy_opening_batches WHERE id=?').bind(id).first<any>();
  if (!batch || !['approved','posting'].includes(String(batch.status))) {
    return c.json({ok:false,error:'승인된 초기 잔액 배치만 기록할 수 있습니다.'},409);
  }
  const allRows = await c.env.DB.prepare("SELECT * FROM v3_economy_opening_items WHERE batch_id=? ORDER BY id").bind(id).all<any>();
  const canonicalItems = (allRows.results || []).map((item:any) => ({
    user_id:String(item.user_id),bucket:String(item.bucket),amount_atoms:Number(item.amount_atoms),
    source_table:String(item.source_table),source_row_id:String(item.source_row_id),
    source_field:String(item.source_field),source_checksum:String(item.source_checksum),
    evidence_note:String(item.evidence_note)
  })).sort((a:any,b:any) =>
    (a.user_id+a.bucket+a.source_table+a.source_row_id+a.source_field)
      .localeCompare(b.user_id+b.bucket+b.source_table+b.source_row_id+b.source_field)
  );
  const verifiedChecksum = await sha256Hex(JSON.stringify(canonicalItems));
  if (verifiedChecksum !== String(batch.checksum)) {
    return c.json({ok:false,error:'초기 잔액 배치 체크섬이 일치하지 않습니다. 기록을 중단했습니다.'},409);
  }
  await c.env.DB.prepare("UPDATE v3_economy_opening_batches SET status='posting' WHERE id=? AND status='approved'").bind(id).run();
  const equityAccount = await ensureLedgerAccount(c.env.DB,'system','timelink','TL','genesis_equity');
  const rows = await c.env.DB.prepare("SELECT * FROM v3_economy_opening_items WHERE batch_id=? AND status='pending' ORDER BY id").bind(id).all<any>();
  let posted = 0;
  try {
    for (const item of rows.results || []) {
      const userAccount = await ensureLedgerAccount(c.env.DB,'user',Number(item.user_id),'TL',String(item.bucket));
      const tx = await postLedgerTransaction(c.env.DB,{
        idempotencyKey:'opening:'+id+':'+String(item.id),
        transactionType:'opening_balance',
        source:'admin_manual_opening',
        referenceType:'opening_batch',
        referenceId:id,
        actorUserId:String(actor.id),
        description:'관리자 승인 초기 잔액 입력',
        metadata:{
          item_id:item.id,source_table:item.source_table,source_row_id:item.source_row_id,
          source_field:item.source_field,source_checksum:item.source_checksum,
          evidence_note:item.evidence_note,batch_checksum:batch.checksum
        },
        lines:[
          {accountId:userAccount,assetCode:'TL',amountAtoms:tlToAtoms(Number(item.amount_atoms))},
          {accountId:equityAccount,assetCode:'TL',amountAtoms:-tlToAtoms(Number(item.amount_atoms))}
        ]
      });
      await c.env.DB.prepare(`UPDATE v3_economy_opening_items
        SET status='posted',ledger_transaction_id=?,posted_at=datetime('now')
        WHERE id=? AND status='pending'`).bind(tx.id,item.id).run();
      posted++;
    }
    const remaining = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM v3_economy_opening_items WHERE batch_id=? AND status<>'posted'").bind(id).first<any>();
    if (Number(remaining?.n || 0) === 0) {
      await c.env.DB.prepare("UPDATE v3_economy_opening_batches SET status='posted',posted_at=datetime('now') WHERE id=?").bind(id).run();
    }
    return c.json({ok:true,batch_id:id,posted_this_run:posted,remaining:Number(remaining?.n||0),status:Number(remaining?.n||0)===0?'posted':'posting'});
  } catch (e:any) {
    return c.json({ok:false,batch_id:id,posted_this_run:posted,status:'posting',error:e?.message || '초기 잔액 원장 기록 실패',retry_safe:true},500);
  }
});

router.get('/admin/opening-batches/:id', async (c) => {
  const actor = c.get('user');
  if (!await requireLedgerAdmin(c.env.DB, actor.id)) return c.json({ok:false,error:'관리자 권한 필요'},403);
  const id = c.req.param('id');
  const batch = await c.env.DB.prepare('SELECT * FROM v3_economy_opening_batches WHERE id=?').bind(id).first();
  if (!batch) return c.json({ok:false,error:'배치를 찾지 못했습니다.'},404);
  const items = await c.env.DB.prepare('SELECT * FROM v3_economy_opening_items WHERE batch_id=? ORDER BY id').bind(id).all();
  return c.json({ok:true,batch,items:items.results||[]});
});


export default router;
