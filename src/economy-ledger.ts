import type { Env } from './types';

export type LedgerOwnerType = 'user' | 'platform' | 'escrow' | 'system' | 'partner';

export interface LedgerLine {
  accountId: string;
  assetCode: 'TL' | 'TLC';
  amountAtoms: number;
}

export interface LedgerTransactionInput {
  idempotencyKey: string;
  transactionType: string;
  source: string;
  lines: LedgerLine[];
  referenceType?: string;
  referenceId?: string;
  actorUserId?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export async function ensureLedgerAccount(
  db: D1Database,
  ownerType: LedgerOwnerType,
  ownerId: string | number,
  assetCode: 'TL' | 'TLC',
  bucket: string
): Promise<string> {
  const normalizedOwnerId = String(ownerId);
  const proposedId = crypto.randomUUID();
  await db.prepare(`
    INSERT OR IGNORE INTO v3_economy_accounts
      (id, owner_type, owner_id, asset_code, bucket)
    VALUES (?, ?, ?, ?, ?)
  `).bind(proposedId, ownerType, normalizedOwnerId, assetCode, bucket).run();

  const account = await db.prepare(`
    SELECT id, status FROM v3_economy_accounts
    WHERE owner_type=? AND owner_id=? AND asset_code=? AND bucket=?
  `).bind(ownerType, normalizedOwnerId, assetCode, bucket).first<{id:string;status:string}>();

  if (!account) throw new Error('V3 ledger account creation failed');
  if (account.status !== 'active') throw new Error('V3 ledger account is not active');

  await db.prepare(`
    INSERT OR IGNORE INTO v3_economy_balances (account_id)
    VALUES (?)
  `).bind(account.id).run();

  return account.id;
}

export async function postLedgerTransaction(
  db: D1Database,
  input: LedgerTransactionInput
): Promise<{id:string;replayed:boolean}> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
    throw new Error('A valid idempotency key is required');
  }
  if (!input.transactionType || !input.source || input.lines.length < 2) {
    throw new Error('Transaction type, source, and at least two ledger lines are required');
  }

  const totals = new Map<string, number>();
  const accountIds = new Set<string>();
  for (const line of input.lines) {
    if (!line.accountId || !['TL','TLC'].includes(line.assetCode) ||
        !Number.isSafeInteger(line.amountAtoms) || line.amountAtoms === 0) {
      throw new Error('Invalid ledger line');
    }
    const key = line.accountId + ':' + line.assetCode;
    if (accountIds.has(key)) throw new Error('Duplicate account line; aggregate it before posting');
    accountIds.add(key);
    totals.set(line.assetCode, (totals.get(line.assetCode) || 0) + line.amountAtoms);
  }
  for (const [asset, total] of totals) {
    if (total !== 0) throw new Error(`Unbalanced ${asset} transaction`);
  }

  const fingerprint = JSON.stringify({
    transactionType: input.transactionType,
    source: input.source,
    referenceType: input.referenceType || null,
    referenceId: input.referenceId || null,
    lines: [...input.lines].sort((a,b) => a.accountId.localeCompare(b.accountId))
  });

  const existing = await db.prepare(`
    SELECT id, metadata_json FROM v3_economy_transactions WHERE idempotency_key=?
  `).bind(input.idempotencyKey).first<{id:string;metadata_json:string|null}>();
  if (existing) {
    let oldFingerprint = '';
    try { oldFingerprint = String(JSON.parse(existing.metadata_json || '{}')._fingerprint || ''); } catch {}
    if (oldFingerprint !== fingerprint) throw new Error('Idempotency key was already used for a different transaction');
    return { id: existing.id, replayed: true };
  }

  for (const line of input.lines) {
    const account = await db.prepare(`
      SELECT a.id, a.asset_code, a.status, b.account_id
      FROM v3_economy_accounts a
      LEFT JOIN v3_economy_balances b ON b.account_id=a.id
      WHERE a.id=?
    `).bind(line.accountId).first<{id:string;asset_code:string;status:string;account_id:string|null}>();
    if (!account || account.status !== 'active' || account.asset_code !== line.assetCode || !account.account_id) {
      throw new Error('Ledger account missing, inactive, or asset mismatch');
    }
  }

  const transactionId = crypto.randomUUID();
  const metadata = { ...(input.metadata || {}), _fingerprint: fingerprint };
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO v3_economy_transactions
        (id,idempotency_key,transaction_type,source,reference_type,reference_id,actor_user_id,description,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).bind(
      transactionId, input.idempotencyKey, input.transactionType, input.source,
      input.referenceType || null, input.referenceId || null,
      input.actorUserId || null, input.description || null, JSON.stringify(metadata)
    )
  ];

  for (const line of input.lines) {
    statements.push(db.prepare(`
      INSERT INTO v3_economy_entries (transaction_id,account_id,asset_code,amount_atoms)
      VALUES (?,?,?,?)
    `).bind(transactionId, line.accountId, line.assetCode, line.amountAtoms));
    statements.push(db.prepare(`
      UPDATE v3_economy_balances
      SET available_atoms=available_atoms+?, version=version+1, updated_at=datetime('now')
      WHERE account_id=?
    `).bind(line.amountAtoms, line.accountId));
  }

  try {
    await db.batch(statements);
    return { id: transactionId, replayed: false };
  } catch (error) {
    const raced = await db.prepare(`
      SELECT id, metadata_json FROM v3_economy_transactions WHERE idempotency_key=?
    `).bind(input.idempotencyKey).first<{id:string;metadata_json:string|null}>();
    if (raced) {
      let oldFingerprint = '';
      try { oldFingerprint = String(JSON.parse(raced.metadata_json || '{}')._fingerprint || ''); } catch {}
      if (oldFingerprint === fingerprint) return { id: raced.id, replayed: true };
      throw new Error('Idempotency key conflict');
    }
    throw error;
  }
}

export async function getLedgerWallet(db: D1Database, userId: number) {
  const rows = await db.prepare(`
    SELECT a.asset_code, a.bucket, b.available_atoms, b.held_atoms, b.version
    FROM v3_economy_accounts a
    JOIN v3_economy_balances b ON b.account_id=a.id
    WHERE a.owner_type='user' AND a.owner_id=? AND a.status='active'
    ORDER BY a.asset_code, a.bucket
  `).bind(String(userId)).all();
  return rows.results || [];
}

export async function getLedgerHistory(db: D1Database, userId: number, limit = 50, offset = 0) {
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const safeOffset = Math.max(0, Math.floor(offset));
  const rows = await db.prepare(`
    SELECT e.id AS entry_id, e.asset_code, e.amount_atoms, e.created_at,
           t.id AS transaction_id, t.transaction_type, t.source,
           t.reference_type, t.reference_id, t.description
    FROM v3_economy_entries e
    JOIN v3_economy_accounts a ON a.id=e.account_id
    JOIN v3_economy_transactions t ON t.id=e.transaction_id
    WHERE a.owner_type='user' AND a.owner_id=?
    ORDER BY e.id DESC
    LIMIT ? OFFSET ?
  `).bind(String(userId), safeLimit, safeOffset).all();
  return rows.results || [];
}
