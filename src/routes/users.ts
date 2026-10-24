import { Hono } from 'hono';
import { authMiddleware } from '../middleware';
import type { Env, User } from '../types';
import { readV5Wallet } from '../v5-wallet';
import { listenerCashoutEligibility } from '../v5-cashout';
import { getLedgerHistory,atomsToTl } from '../economy-ledger';
import { reconcilePristineSignupBonus } from '../economics';

const router = new Hono<{ Bindings: Env; Variables: { user: User } }>();

router.use('*', authMiddleware);

// GET /me
router.get('/me', (c) => {
  const u = c.get('user');
  return c.json({
    id: u.id, email: u.email, username: u.username,
    poc_index: u.poc_index, false_dispute_strikes: u.false_dispute_strikes,
    account_forfeited: !!u.account_forfeited, created_at: u.created_at,
  });
});

// GET /me/wallet
router.get('/me/wallet', async (c) => {
  const u = c.get('user');
  let wallet;
  try {
    await reconcilePristineSignupBonus(c.env.DB,u);
    wallet=await readV5Wallet(c.env.DB,u.id);
  }
  catch { return c.json({error:'V5_WALLET_NOT_READY'},503); }
  const eligibility=await listenerCashoutEligibility(c.env.DB,u.id);
  const exchangeable_tl = eligibility.eligible?Math.min(wallet.tl_p,eligibility.principalRemainingAtoms/10000):0;
  const tlc_mineable = u.poc_index > 0 ? u.total_tl_spent * 0.5 * u.poc_index : 0;
  return c.json({
    ...wallet,
    tlc_balance: u.tlc_balance,
    total_tl_spent: u.total_tl_spent,
    total_tl_earned: u.total_tl_earned,
    total_tl_exchanged: u.total_tl_exchanged,
    exchangeable_tl,
    cashout_eligibility:eligibility,
    tlc_mineable,
    poc_index: u.poc_index,
    tl_suspended: !!u.tl_suspended,
    false_dispute_strikes: u.false_dispute_strikes,
    account_forfeited: !!u.account_forfeited,
  });
});

// GET /me/transactions
router.get('/me/transactions', async (c) => {
  const u = c.get('user');
  const limit = Number(c.req.query('limit') || 20);
  const offset = Number(c.req.query('offset') || 0);
  if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(offset)||limit<1||offset<0)return c.json({error:'INVALID_PAGINATION'},400);
  const rows=await getLedgerHistory(c.env.DB,u.id,limit,offset) as any[];
  return c.json(rows.map(row=>({...row,tx_type:row.transaction_type,amount:row.asset_code==='TL'?atomsToTl(row.amount_atoms):Number(row.amount_atoms)/1e9,note:row.description})));
});

// GET /me/poc-history
router.get('/me/poc-history', async (c) => {
  const u = c.get('user');
  const rows = await c.env.DB.prepare(
    `SELECT * FROM poc_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`
  ).bind(u.id).all();
  return c.json(rows.results);
});

export default router;
