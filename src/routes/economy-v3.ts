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


/**
 * Read-only legacy balance preview.
 * Legacy buckets are reported independently; nothing is summed or imported.
 */
router.get('/reconciliation/preview', async (c) => {
  const user = c.get('user');
  const schema = await c.env.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>();
  const available = new Set((schema.results || []).map((column) => column.name));
  const candidates = [
    'tl', 'tl_balance', 'tl_p', 'tl_a', 'tl_b', 'tlc_balance',
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
  return c.json({
    ok: true,
    read_only: true,
    migration_state: ledger.length ? 'ledger_initialized' : 'legacy_only',
    legacy_fields: legacy,
    detected_columns: selected,
    v3_accounts: ledger,
    reconciliation: {
      status: 'not_imported',
      automatic_import: false,
      rule: 'Each legacy field is reported independently. No fields are added together, converted, or credited.',
      review_required: true
    }
  });
});

export default router;
