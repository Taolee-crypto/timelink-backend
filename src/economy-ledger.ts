import { CREATOR_SHARE_RATE } from './economy-policy';

export const TL_ATOMS_PER_TL = 10000;
export function tlToAtoms(value:number):number {
  const atoms=Math.round(Number(value)*TL_ATOMS_PER_TL);
  if(!Number.isSafeInteger(atoms)||atoms<0) throw new Error('Invalid TL amount');
  return atoms;
}
export function atomsToTl(value:number):number {
  return Number((Number(value||0)/TL_ATOMS_PER_TL).toFixed(4));
}

export async function assertTLAtomScale(db:D1Database):Promise<void>{
  const row=await db.prepare("SELECT decimals FROM v3_economy_assets WHERE asset_code='TL'").first<any>();
  if(Number(row?.decimals)!==4) throw new Error('V3_TL_ATOM_SCALE_NOT_READY');
}

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
  // Extra statements participate in the same D1 batch as the ledger posting.
  // Used for atomic playback-session compare-and-swap updates.
  atomicStatements?: D1PreparedStatement[];
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

function sameFingerprintAfterTLScale(oldFingerprint:string,newFingerprint:string):boolean {
  try {
    const oldValue=JSON.parse(oldFingerprint);
    const newValue=JSON.parse(newFingerprint);
    if(!Array.isArray(oldValue.lines)||!Array.isArray(newValue.lines)) return false;
    oldValue.lines=oldValue.lines.map((line:any)=>({
      ...line,
      amountAtoms:line.assetCode==='TL'?Number(line.amountAtoms)*TL_ATOMS_PER_TL:Number(line.amountAtoms)
    }));
    return JSON.stringify(oldValue)===JSON.stringify(newValue);
  } catch { return false; }
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
    const nextTotal = (totals.get(line.assetCode) || 0) + line.amountAtoms;
    if (!Number.isSafeInteger(nextTotal)) throw new Error('Ledger total exceeds safe integer range');
    totals.set(line.assetCode, nextTotal);
  }
  for (const [asset, total] of totals) {
    if (total !== 0) throw new Error(`Unbalanced ${asset} transaction`);
  }

  const fingerprint = JSON.stringify({
    transactionType: input.transactionType,
    source: input.source,
    referenceType: input.referenceType || null,
    referenceId: input.referenceId || null,
    actorUserId: input.actorUserId || null,
    description: input.description || null,
    metadata: input.metadata || {},
    lines: [...input.lines].sort((a,b) => a.accountId.localeCompare(b.accountId))
  });

  const existing = await db.prepare(`
    SELECT id, metadata_json FROM v3_economy_transactions WHERE idempotency_key=?
  `).bind(input.idempotencyKey).first<{id:string;metadata_json:string|null}>();
  if (existing) {
    let oldFingerprint = '';
    try { oldFingerprint = String(JSON.parse(existing.metadata_json || '{}')._fingerprint || ''); } catch {}
    if (oldFingerprint !== fingerprint && !sameFingerprintAfterTLScale(oldFingerprint,fingerprint)) throw new Error('Idempotency key was already used for a different transaction');
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
    if (input.atomicStatements?.length) statements.push(...input.atomicStatements);
    await db.batch(statements);
    return { id: transactionId, replayed: false };
  } catch (error) {
    const raced = await db.prepare(`
      SELECT id, metadata_json FROM v3_economy_transactions WHERE idempotency_key=?
    `).bind(input.idempotencyKey).first<{id:string;metadata_json:string|null}>();
    if (raced) {
      let oldFingerprint = '';
      try { oldFingerprint = String(JSON.parse(raced.metadata_json || '{}')._fingerprint || ''); } catch {}
      if (oldFingerprint === fingerprint || sameFingerprintAfterTLScale(oldFingerprint,fingerprint)) return { id: raced.id, replayed: true };
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


export type TrackPoolSource = 'paid' | 'ad' | 'bonus' | 'legacy';

export async function getTrackPoolBalances(db:D1Database,userId:number,shareId:string) {
  await assertTLAtomScale(db);
  const rows=await db.prepare(`
    SELECT a.bucket,b.available_atoms,b.held_atoms
    FROM v3_economy_accounts a
    JOIN v3_economy_balances b ON b.account_id=a.id
    WHERE a.owner_type='user' AND a.owner_id=? AND a.asset_code='TL'
      AND a.bucket IN (?,?,?,?)
  `).bind(String(userId),
    'track_pool:'+shareId+':paid','track_pool:'+shareId+':ad',
    'track_pool:'+shareId+':bonus','track_pool:'+shareId+':legacy'
  ).all<any>();
  const result:Record<string,number>={paid:0,ad:0,bonus:0,legacy:0};
  for(const row of rows.results||[]){
    const match=String(row.bucket||'').match(/^track_pool:[^:]+:(paid|ad|bonus|legacy)$/);
    if(match) result[match[1]]=Number(row.available_atoms||0);
  }
  return result;
}

export async function chargeTrackPool(
  db:D1Database,
  userId:number,
  shareId:string,
  amountAtoms:number,
  idempotencyKey:string,
  description='공통 지갑에서 곡 전용 TL 풀로 내부 이체'
) {
  await assertTLAtomScale(db);
  if(!Number.isSafeInteger(amountAtoms)||amountAtoms<=0) throw new Error('Invalid track charge amount');
  const prior=await db.prepare(`
    SELECT id,transaction_type,source,reference_type,reference_id,actor_user_id,metadata_json
    FROM v3_economy_transactions WHERE idempotency_key=? LIMIT 1
  `).bind(idempotencyKey).first<any>();
  if(prior){
    let metadata:any={};
    try{metadata=JSON.parse(prior.metadata_json||'{}');}catch{}
    const stored=Number(metadata.amount_atoms||0);
    const sameAmount=stored===amountAtoms || stored*TL_ATOMS_PER_TL===amountAtoms;
    if(prior.transaction_type==='track_charge'&&prior.source==='wallet_to_track'&&
       prior.reference_type==='track'&&String(prior.reference_id)===shareId&&
       String(prior.actor_user_id)===String(userId)&&sameAmount){
      return {id:prior.id,replayed:true,amountAtoms,allocation:metadata.allocation||{}};
    }
    throw new Error('Idempotency key was already used for a different transaction');
  }
  const paidAccount=await ensureLedgerAccount(db,'user',userId,'TL','wallet_paid');
  const adAccount=await ensureLedgerAccount(db,'user',userId,'TL','wallet_ad');
  const bonusAccount=await ensureLedgerAccount(db,'user',userId,'TL','wallet_bonus');
  const read=async(id:string)=>{
    const row=await db.prepare('SELECT available_atoms FROM v3_economy_balances WHERE account_id=?').bind(id).first<any>();
    return Number(row?.available_atoms||0);
  };
  const paid=await read(paidAccount),ad=await read(adAccount),bonus=await read(bonusAccount);
  if(paid+ad+bonus<amountAtoms) throw new Error('INSUFFICIENT_TL');
  let remaining=amountAtoms;
  const takeAd=Math.min(ad,remaining);remaining-=takeAd;
  const takeBonus=Math.min(bonus,remaining);remaining-=takeBonus;
  const takePaid=remaining;
  const lines:any[]=[];
  if(takeAd){
    const pool=await ensureLedgerAccount(db,'user',userId,'TL','track_pool:'+shareId+':ad');
    lines.push({accountId:adAccount,assetCode:'TL',amountAtoms:-takeAd},{accountId:pool,assetCode:'TL',amountAtoms:takeAd});
  }
  if(takeBonus){
    const pool=await ensureLedgerAccount(db,'user',userId,'TL','track_pool:'+shareId+':bonus');
    lines.push({accountId:bonusAccount,assetCode:'TL',amountAtoms:-takeBonus},{accountId:pool,assetCode:'TL',amountAtoms:takeBonus});
  }
  if(takePaid){
    const pool=await ensureLedgerAccount(db,'user',userId,'TL','track_pool:'+shareId+':paid');
    lines.push({accountId:paidAccount,assetCode:'TL',amountAtoms:-takePaid},{accountId:pool,assetCode:'TL',amountAtoms:takePaid});
  }
  const posted=await postLedgerTransaction(db,{
    idempotencyKey,transactionType:'track_charge',source:'wallet_to_track',
    referenceType:'track',referenceId:shareId,actorUserId:String(userId),
    description,
    metadata:{share_id:shareId,amount_atoms:amountAtoms,allocation:{ad:takeAd,bonus:takeBonus,paid:takePaid}},
    lines
  });
  return {id:posted.id,replayed:posted.replayed,amountAtoms,allocation:{ad:takeAd,bonus:takeBonus,paid:takePaid}};
}

export async function settleTrackPlayback(
  db:D1Database,
  input:{
    userId:number;creatorId:number;shareId:string;amountAtoms:number;
    idempotencyKey:string;fileId:number;playedSeconds:number;
    atomicStatements?:D1PreparedStatement[];
  }
) {
  const {userId,creatorId,shareId,amountAtoms,idempotencyKey,fileId,playedSeconds}=input;
  await assertTLAtomScale(db);
  if(!Number.isSafeInteger(amountAtoms)||amountAtoms<=0) throw new Error('Invalid playback settlement amount');
  if(!Number.isSafeInteger(creatorId)||creatorId<=0) throw new Error('Track creator is unavailable');
  const balances=await getTrackPoolBalances(db,userId,shareId);
  if(balances.ad+balances.bonus+balances.paid<amountAtoms) throw new Error('INSUFFICIENT_TRACK_TL');
  let remaining=amountAtoms;
  const used:{paid:number;ad:number;bonus:number}={paid:0,ad:0,bonus:0};
  for(const source of ['ad','bonus','paid'] as const){
    const take=Math.min(balances[source],remaining);
    used[source]=take;remaining-=take;
  }
  const lineMap=new Map<string,{accountId:string;assetCode:'TL';amountAtoms:number}>();
  const add=(accountId:string,amount:number)=>{
    if(!amount)return;
    const old=lineMap.get(accountId);
    if(old) old.amountAtoms+=amount;
    else lineMap.set(accountId,{accountId,assetCode:'TL',amountAtoms:amount});
  };
  let creatorShareAtoms=0,platformShareAtoms=0;
  for(const source of ['paid','ad','bonus'] as const){
    const consumed=used[source];
    if(!consumed)continue;
    const creatorPart=Math.round(consumed*CREATOR_SHARE_RATE);
    const platformPart=consumed-creatorPart;
    const pool=await ensureLedgerAccount(db,'user',userId,'TL','track_pool:'+shareId+':'+source);
    const creatorBucket=source==='paid'?'wallet_paid':'wallet_ad';
    const creatorAccount=await ensureLedgerAccount(
      db,userId===creatorId?'escrow':'user',creatorId,'TL',
      userId===creatorId?'self_play_creator_share_'+source:creatorBucket
    );
    const platformAccount=await ensureLedgerAccount(db,'platform','timelink','TL','playback_revenue_'+source);
    add(pool,-consumed);add(creatorAccount,creatorPart);add(platformAccount,platformPart);
    creatorShareAtoms+=creatorPart;platformShareAtoms+=platformPart;
  }
  const posted=await postLedgerTransaction(db,{
    idempotencyKey,transactionType:'track_playback_settlement',source:'tl3_actual_playback',
    referenceType:'track',referenceId:shareId,actorUserId:String(userId),
    description:'실제 재생 시간 기준 곡별 TL 정산',
    metadata:{
      file_id:fileId,share_id:shareId,played_seconds:playedSeconds,
      amount_atoms:amountAtoms,creator_share_atoms:creatorShareAtoms,
      platform_share_atoms:platformShareAtoms,source_allocation:used,
      self_play_held:userId===creatorId
    },
    lines:[...lineMap.values()],
    atomicStatements:[
      ...(input.atomicStatements||[]),
      db.prepare('INSERT INTO play_events(file_id,player_user_id,tl_deducted,revenue_credited,file_tl_after,play_duration_seconds,car_mode) VALUES(?,?,?,?,?,?,0)')
        .bind(fileId,userId,atomsToTl(amountAtoms),userId===creatorId?0:atomsToTl(creatorShareAtoms),atomsToTl(balances.ad+balances.bonus+balances.paid-amountAtoms),playedSeconds)
    ]
  });
  return {id:posted.id,replayed:posted.replayed,amountAtoms,creatorShareAtoms,platformShareAtoms,used};
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
