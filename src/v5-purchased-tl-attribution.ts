/**
 * Read-only purchased TL_P provenance reconstruction.
 *
 * A wallet_paid balance mixes the customer's purchases with independent
 * creator cash-source income. Never treat its total as purchased TL_P.
 * Replay journal entries in insertion order, assigning debit consumption to
 * oldest purchased lots first. Track-pool charging/early-stop reversals move
 * provenance without consuming it. Unknown historical payments fail closed.
 */
export interface PurchasedLotRow {
  payment_key:string; user_id:string; paid_atoms:number; converted_atoms:number;
  payment_mode:'live'|'test'|'unknown'; refund_deadline_ms:number|null;
  remaining_purchased_atoms:number|null; consumer_rights_cleared:number;
  legal_review_approved:number; refund_dispute_pending:number;
}
export interface PaidAccountRow {
  id:string; bucket:string; available_atoms:number; held_atoms:number; version:number;
}
export interface PaidEntryRow {
  id:number;transaction_id:string;bucket:string;amount_atoms:number;
  transaction_type:string;idempotency_key:string;reference_id:string|null;
}
export interface PurchasedLotBalance {
  paymentKey:string; purchasedAtoms:number; convertedAtoms:number;
  remainingPurchasedAtoms:number; walletAtoms:number;
  pools:{bucket:string;atoms:number}[];
}
export interface PurchasedAttribution {
  lots:PurchasedLotBalance[];
  accounts:PaidAccountRow[];
  rowsChecked:number;
  sourcePolicy:'PURCHASED_FIRST_FIFO';
}

function safeAtoms(value:number,label:string):number {
  if(!Number.isSafeInteger(value)||value<0)throw Error('PURCHASE_ATTRIBUTION_INVALID_'+label);
  return value;
}
function isPaidPool(bucket:string):boolean {
  return bucket.startsWith('track_pool:')&&bucket.endsWith(':paid');
}
function isPaidAccount(bucket:string):boolean {
  return bucket==='wallet_paid'||isPaidPool(bucket);
}
function assertValidIdentifier(value:string):void {
  if(!/^[A-Za-z0-9:_-]{3,200}$/.test(value))throw Error('PURCHASE_ATTRIBUTION_INVALID_IDENTIFIER');
}
type ProvenanceState={untagged:number;lots:Map<string,number>};
type Consumed={untagged:number;lots:Map<string,number>};
function total(s:ProvenanceState):number {
  let result=s.untagged;
  for(const value of s.lots.values())result+=value;
  return result;
}
function take(s:ProvenanceState,atoms:number,onlyLot?:string):Consumed {
  safeAtoms(atoms,'DEBIT');
  if(total(s)<atoms)throw Error('PURCHASE_ATTRIBUTION_UNBALANCED_DEBIT');
  let left=atoms;
  const result:Consumed={untagged:0,lots:new Map()};
  if(onlyLot){
    const available=s.lots.get(onlyLot)||0;
    if(available<atoms)throw Error('PURCHASE_ATTRIBUTION_CONVERSION_OTHER_FUNDS');
    s.lots.set(onlyLot,available-atoms);
    result.lots.set(onlyLot,atoms);
    return result;
  }
  // Older purchases are consumed first; non-purchase royalty income is last.
  for(const [key,available] of s.lots){
    if(left===0)break;
    const used=Math.min(left,available);
    if(used){s.lots.set(key,available-used);result.lots.set(key,used);left-=used;}
  }
  if(left){if(s.untagged<left)throw Error('PURCHASE_ATTRIBUTION_UNBALANCED_CASH_SOURCE');
    s.untagged-=left;result.untagged=left;}
  return result;
}
function add(s:ProvenanceState,c:Consumed):void {
  s.untagged+=c.untagged;
  for(const [key,atoms] of c.lots)s.lots.set(key,(s.lots.get(key)||0)+atoms);
}
function untaggedCredit(s:ProvenanceState,atoms:number):void {
  safeAtoms(atoms,'CREDIT');s.untagged+=atoms;
}

/** Pure replay. It rejects ledger gaps and drift rather than guessing. */
export function replayPurchasedTlAttribution(input:{
  userId:string;lots:PurchasedLotRow[];accounts:PaidAccountRow[];entries:PaidEntryRow[];
}):PurchasedAttribution {
  const {lots,accounts,entries}=input;
  const lotsByKey=new Map<string,PurchasedLotRow>();
  for(const lot of lots){
    assertValidIdentifier(lot.payment_key);
    if(String(lot.user_id)!==String(input.userId)||lotsByKey.has(lot.payment_key))
      throw Error('PURCHASE_ATTRIBUTION_INVALID_LOT_OWNER');
    safeAtoms(Number(lot.paid_atoms),'LOT_AMOUNT');
    safeAtoms(Number(lot.converted_atoms),'CONVERTED_AMOUNT');
    if(lot.converted_atoms>lot.paid_atoms)throw Error('PURCHASE_ATTRIBUTION_CONVERSION_OVERFLOW');
    lotsByKey.set(lot.payment_key,lot);
  }
  const knownAccounts=new Map<string,PaidAccountRow>();
  const states=new Map<string,ProvenanceState>();
  const netByBucket=new Map<string,number>();
  for(const a of accounts){
    if(!isPaidAccount(a.bucket)||knownAccounts.has(a.bucket))
      throw Error('PURCHASE_ATTRIBUTION_ACCOUNT_SCOPE');
    safeAtoms(Number(a.available_atoms),'CURRENT_BALANCE');
    safeAtoms(Number(a.held_atoms),'HELD_BALANCE');
    safeAtoms(Number(a.version),'ACCOUNT_VERSION');
    knownAccounts.set(a.bucket,a);
    netByBucket.set(a.bucket,0);
  }
  let lastId=0;
  for(const e of entries){
    if(!Number.isSafeInteger(e.id)||e.id<=lastId)throw Error('PURCHASE_ATTRIBUTION_LEDGER_ORDER');
    lastId=e.id;
    if(!knownAccounts.has(e.bucket)||!Number.isSafeInteger(e.amount_atoms)||!e.amount_atoms)
      throw Error('PURCHASE_ATTRIBUTION_LEDGER_ENTRY');
    netByBucket.set(e.bucket,(netByBucket.get(e.bucket)||0)+e.amount_atoms);
  }
  for(const a of accounts){
    const opening=a.available_atoms-(netByBucket.get(a.bucket)||0);
    safeAtoms(opening,'OPENING_BALANCE');
    states.set(a.bucket,{untagged:opening,lots:new Map()});
  }
  const seenPayments=new Set<string>();
  const converted=new Map<string,number>();
  const seenTransactions=new Set<string>();
  let i=0;
  while(i<entries.length){
    const first=entries[i],group:PaidEntryRow[]=[];
    while(i<entries.length && entries[i].transaction_id===first.transaction_id){
      const e=entries[i++];
      if(e.transaction_type!==first.transaction_type||e.idempotency_key!==first.idempotency_key)
        throw Error('PURCHASE_ATTRIBUTION_TRANSACTION_METADATA');
      group.push(e);
    }
    if(seenTransactions.has(first.transaction_id))
      throw Error('PURCHASE_ATTRIBUTION_INTERLEAVED_TRANSACTION');
    seenTransactions.add(first.transaction_id);
    const type=first.transaction_type;
    const debits=group.filter(e=>e.amount_atoms<0);
    const credits=group.filter(e=>e.amount_atoms>0);
    if(type==='payment_credit'){
      if(debits.length||credits.length!==1||credits[0].bucket!=='wallet_paid')
        throw Error('PURCHASE_ATTRIBUTION_PAYMENT_SHAPE');
      const lot=lotsByKey.get(first.idempotency_key);
      if(!lot)throw Error('PURCHASE_ATTRIBUTION_LEGACY_PAYMENT_NOT_BACKFILLED');
      if(seenPayments.has(lot.payment_key)||credits[0].amount_atoms!==lot.paid_atoms)
        throw Error('PURCHASE_ATTRIBUTION_PAYMENT_MISMATCH');
      seenPayments.add(lot.payment_key);
      add(states.get('wallet_paid')!,{untagged:0,lots:new Map([[lot.payment_key,lot.paid_atoms]])});
      continue;
    }
    if(type==='track_charge'||type==='v5_early_stop'){
      const send=type==='track_charge'
        ?debits.find(e=>e.bucket==='wallet_paid')
        :debits.find(e=>isPaidPool(e.bucket));
      const receive=type==='track_charge'
        ?credits.find(e=>isPaidPool(e.bucket))
        :credits.find(e=>e.bucket==='wallet_paid');
      if(group.length!==2||!send||!receive||-send.amount_atoms!==receive.amount_atoms)
        throw Error('PURCHASE_ATTRIBUTION_TRANSFER_SHAPE');
      add(states.get(receive.bucket)!,take(states.get(send.bucket)!,-send.amount_atoms));
      continue;
    }
    if(type==='v5_purchase_maturity'){
      const key=String(first.reference_id||'');
      if(!lotsByKey.has(key))throw Error('PURCHASE_ATTRIBUTION_UNKNOWN_CONVERSION');
      let used=0;
      if(credits.length)throw Error('PURCHASE_ATTRIBUTION_CONVERSION_PAID_CREDIT');
      for(const e of debits){
        take(states.get(e.bucket)!,-e.amount_atoms,key);
        used+=-e.amount_atoms;
      }
      converted.set(key,(converted.get(key)||0)+used);
      continue;
    }
    // All unrecognized source credits are non-purchase cash revenue. All
    // outgoing amounts consume oldest purchases first, minimizing the amount
    // left eligible for maturity conversion.
    for(const e of debits)take(states.get(e.bucket)!,-e.amount_atoms);
    for(const e of credits)untaggedCredit(states.get(e.bucket)!,e.amount_atoms);
  }
  for(const a of accounts){
    if(total(states.get(a.bucket)!)!==a.available_atoms)
      throw Error('PURCHASE_ATTRIBUTION_LEDGER_BALANCE_DRIFT');
  }
  const output:PurchasedLotBalance[]=[];
  for(const lot of lots){
    if(!seenPayments.has(lot.payment_key))throw Error('PURCHASE_ATTRIBUTION_MISSING_PURCHASE_EVENT');
    if((converted.get(lot.payment_key)||0)!==lot.converted_atoms)
      throw Error('PURCHASE_ATTRIBUTION_CONVERSION_LEDGER_MISMATCH');
    const poolBalances:{bucket:string;atoms:number}[]=[];
    let walletAtoms=0,poolTotal=0;
    for(const [bucket,state] of states){
      const value=state.lots.get(lot.payment_key)||0;
      if(!value)continue;
      if(bucket==='wallet_paid')walletAtoms=value;
      else{poolBalances.push({bucket,atoms:value});poolTotal+=value;}
    }
    const remainingPurchasedAtoms=walletAtoms+poolTotal;
    safeAtoms(remainingPurchasedAtoms,'REMAINING_LOT');
    if(remainingPurchasedAtoms+lot.converted_atoms>lot.paid_atoms)
      throw Error('PURCHASE_ATTRIBUTION_EXCEEDS_PURCHASE');
    output.push({paymentKey:lot.payment_key,purchasedAtoms:lot.paid_atoms,
      convertedAtoms:lot.converted_atoms,remainingPurchasedAtoms,
      walletAtoms,pools:poolBalances});
  }
  return {lots:output,accounts,rowsChecked:entries.length,sourcePolicy:'PURCHASED_FIRST_FIFO'};
}

/** Read-only reconciliation against the double-entry V5 ledger. */
export async function readPurchasedTlAttribution(db:D1Database,userId:string):Promise<PurchasedAttribution> {
  if(!/^[0-9]{1,15}$/.test(String(userId)))throw Error('PURCHASE_ATTRIBUTION_USER_ID');
  const lotsResult=await db.prepare(
    'SELECT payment_key,user_id,paid_atoms,converted_atoms,payment_mode,refund_deadline_ms,'+
    'remaining_purchased_atoms,consumer_rights_cleared,legal_review_approved,refund_dispute_pending '+
    'FROM v5_purchased_tl_lots WHERE user_id=? ORDER BY recorded_at_ms,payment_key LIMIT 501'
  ).bind(userId).all<PurchasedLotRow>();
  const lots=lotsResult.results||[];
  if(lots.length>500)throw Error('PURCHASE_ATTRIBUTION_LOT_LIMIT');
  const accountsResult=await db.prepare(
    "SELECT a.id,a.bucket,b.available_atoms,b.held_atoms,b.version FROM v3_economy_accounts a "+
    "JOIN v3_economy_balances b ON b.account_id=a.id "+
    "WHERE a.owner_type='user' AND a.owner_id=? AND a.asset_code='TL' "+
    "AND (a.bucket='wallet_paid' OR (substr(a.bucket,1,11)='track_pool:' AND substr(a.bucket,-5)=':paid'))"
  ).bind(userId).all<PaidAccountRow>();
  const accounts=accountsResult.results||[];
  if(accounts.length>500)throw Error('PURCHASE_ATTRIBUTION_ACCOUNT_LIMIT');
  const entriesResult=await db.prepare(
    'SELECT e.id,e.transaction_id,a.bucket,e.amount_atoms,t.transaction_type,t.idempotency_key,t.reference_id '+
    'FROM v3_economy_entries e JOIN v3_economy_accounts a ON a.id=e.account_id '+
    'JOIN v3_economy_transactions t ON t.id=e.transaction_id '+
    "WHERE a.owner_type='user' AND a.owner_id=? AND a.asset_code='TL' AND t.status='posted' "+
    "AND (a.bucket='wallet_paid' OR (substr(a.bucket,1,11)='track_pool:' AND substr(a.bucket,-5)=':paid')) "+
    'ORDER BY e.id ASC LIMIT 20001'
  ).bind(userId).all<PaidEntryRow>();
  const entries=entriesResult.results||[];
  if(entries.length>20000)throw Error('PURCHASE_ATTRIBUTION_LEDGER_ROW_LIMIT');
  return replayPurchasedTlAttribution({userId,lots,accounts,entries});
}
