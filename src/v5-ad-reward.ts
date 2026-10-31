
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

/** Advertising rewards are retired. Existing session/ledger tables remain for audit only. */
export async function startAdReward(_db:D1Database,_userId:number,_adId:string):Promise<Record<string,unknown>> {
  throw new Error('AD_REWARD_RETIRED');
}
export async function completeAdReward(_db:D1Database,_userId:number,_adId:string,_sessionId:string):Promise<Record<string,unknown>> {
  throw new Error('AD_REWARD_RETIRED');
}
