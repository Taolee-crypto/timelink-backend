import { Hono } from 'hono';
import { authMiddleware } from '../middleware';
import type { Env, User } from '../types';
import { getLedgerHistory, getLedgerWallet } from '../economy-ledger';

const router = new Hono<{ Bindings: Env; Variables: { user: User } }>();
router.use('*', authMiddleware);

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

export default router;
