import { Hono } from 'hono';
import { authMiddleware } from '../middleware';
import type { Env, User } from '../types';
import { getLedgerHistory, getLedgerWallet } from '../economy-ledger';

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
  await next();
});

// V3 ledger reads are intentionally separate from legacy wallet reads during cutover.
router.get('/wallet', async (c) => {
  const user = c.get('user');
  const accounts = await getLedgerWallet(c.env.DB, user.id);
  return c.json({
    ok: true,
    ledger_version: 3,
    migration_state: accounts.length ? 'accounts_initialized' : 'not_yet_migrated',
    accounts
  });
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

export default router;
