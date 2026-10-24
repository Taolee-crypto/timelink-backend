import { assertTLAtomScale, ensureLedgerAccount, postLedgerTransaction, tlToAtoms } from './economy-ledger';
import { readV5Wallet } from './v5-wallet';
import { readRewardPolicy } from './v5-reward-policy';

export async function ensureAdRewardSchema(db:D1Database) {
  await db.batch([db.prepare(`CREATE TABLE IF NOT EXISTS v5_ad_reward_sessions (
    id TEXT PRIMARY KEY,user_id INTEGER NOT NULL,ad_id TEXT NOT NULL,day TEXT NOT NULL,
    reward_tl INTEGER NOT NULL CHECK(reward_tl>0),duration_seconds INTEGER NOT NULL,
    started_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
    UNIQUE(user_id,ad_id,day))`),db.prepare(`CREATE TRIGGER IF NOT EXISTS v5_ad_reward_guard BEFORE UPDATE OF status ON v5_ad_reward_sessions
    WHEN NEW.status='completed' BEGIN
      SELECT CASE WHEN OLD.status<>'pending' OR unixepoch()-OLD.started_at<OLD.duration_seconds
        OR unixepoch()-OLD.started_at>3600 THEN RAISE(ABORT,'AD_SESSION_NOT_READY') END;
      SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM tl_ads a WHERE a.id=OLD.ad_id AND a.status='active'
        AND a.budget_tl>0 AND COALESCE(a.spent_tl,0)+OLD.reward_tl<=a.budget_tl)
        THEN RAISE(ABORT,'AD_BUDGET_EXHAUSTED') END;
      UPDATE tl_ads SET spent_tl=COALESCE(spent_tl,0)+OLD.reward_tl,
        completions=COALESCE(completions,0)+1,updated_at=datetime('now') WHERE id=OLD.ad_id;
    END`)]);
}

export async function startAdReward(db:D1Database,userId:number,adId:string) {
  await assertTLAtomScale(db);
  await ensureAdRewardSchema(db);
  const ad=await db.prepare("SELECT * FROM tl_ads WHERE id=? AND status='active'").bind(adId).first<any>();
  if(!ad||Number(ad.budget_tl)<=0)throw new Error('AD_NOT_AVAILABLE');
  const {rules}=await readRewardPolicy(db);
  const reward=Math.min(rules.ad_max,Math.max(rules.ad_min,Math.floor(Number(ad.tl_reward)||rules.ad_default)));
  if(Number(ad.spent_tl||0)+reward>Number(ad.budget_tl))throw new Error('AD_BUDGET_EXHAUSTED');
  const duration=ad.ad_type==='video'?15:ad.ad_type==='audio'?30:10;
  const day=new Date().toISOString().slice(0,10);
  await db.prepare(`INSERT OR IGNORE INTO v5_ad_reward_sessions
    (id,user_id,ad_id,day,reward_tl,duration_seconds,started_at) VALUES (?,?,?,?,?,?,unixepoch())`)
    .bind(crypto.randomUUID(),userId,adId,day,reward,duration).run();
  const row=await db.prepare('SELECT * FROM v5_ad_reward_sessions WHERE user_id=? AND ad_id=? AND day=?')
    .bind(userId,adId,day).first<any>();
  if(row.status==='completed')throw new Error('AD_ALREADY_REWARDED');
  // Allow retry after an abandoned session without granting extra daily rewards.
  if(Math.floor(Date.now()/1000)-Number(row.started_at)>3600){
    await db.prepare("UPDATE v5_ad_reward_sessions SET started_at=unixepoch() WHERE id=? AND status='pending'").bind(row.id).run();
  }
  return {session_id:row.id,reward_tl:row.reward_tl,duration_seconds:row.duration_seconds};
}

export async function completeAdReward(db:D1Database,userId:number,adId:string,sessionId:string) {
  await assertTLAtomScale(db);
  await ensureAdRewardSchema(db);
  const session=await db.prepare('SELECT * FROM v5_ad_reward_sessions WHERE id=? AND user_id=? AND ad_id=?')
    .bind(sessionId,userId,adId).first<any>();
  if(!session)throw new Error('AD_SESSION_REQUIRED');
  const reward=Number(session.reward_tl),atoms=tlToAtoms(reward);
  const source=await ensureLedgerAccount(db,'system','campaign:'+adId,'TL','ad_campaign_issuance');
  const destination=await ensureLedgerAccount(db,'user',userId,'TL','wallet_ad');
  const result=await postLedgerTransaction(db,{
    idempotencyKey:'v5-ad-reward:'+session.id,transactionType:'ad_reward',source:'verified_campaign_session',
    actorUserId:String(userId),referenceType:'ad_session',referenceId:session.id,
    metadata:{ad_id:adId,non_redeemable:true,reward_tl:reward},
    issuanceStatements:[db.prepare('UPDATE v3_economy_balances SET available_atoms=available_atoms+?,version=version+1 WHERE account_id=?').bind(atoms,source)],
    lines:[{accountId:source,assetCode:'TL',amountAtoms:-atoms},{accountId:destination,assetCode:'TL',amountAtoms:atoms}],
    atomicStatements:[
      db.prepare("UPDATE v5_ad_reward_sessions SET status='completed' WHERE id=?").bind(session.id),
      db.prepare('INSERT INTO ad_views(ad_id,user_id,completed,tl_rewarded,duration_watched) VALUES(?,?,1,?,?)')
        .bind(adId,userId,reward,session.duration_seconds)]
  });
  return {ok:true,replayed:result.replayed,tl_a_rewarded:result.replayed?0:reward,
    tl_rewarded:result.replayed?0:reward,wallet:await readV5Wallet(db,userId)};
}
