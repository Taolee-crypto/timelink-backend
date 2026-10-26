import {DEFAULT_CONTRIBUTION_POLICY,validateContributionPolicy,validateContributionEvent,evaluateContributions,type ContributionEvent,type ContributionPolicy} from './v5-contribution-policy';
export async function ensureContributionSchema(db:D1Database){
  const statements=[
    `CREATE TABLE IF NOT EXISTS v5_contribution_policy(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL CHECK(version>=0),policy_json TEXT NOT NULL,updated_by INTEGER,note TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT(datetime('now')))`,
    `CREATE TABLE IF NOT EXISTS v5_contribution_policy_history(version INTEGER PRIMARY KEY,policy_json TEXT NOT NULL,updated_by INTEGER,note TEXT NOT NULL,updated_at TEXT NOT NULL)`,
    `CREATE TRIGGER IF NOT EXISTS v5_contribution_policy_audit AFTER UPDATE ON v5_contribution_policy BEGIN INSERT INTO v5_contribution_policy_history VALUES(NEW.version,NEW.policy_json,NEW.updated_by,NEW.note,NEW.updated_at); END`,
    `CREATE TABLE IF NOT EXISTS v5_contribution_events(event_key TEXT PRIMARY KEY,user_id TEXT NOT NULL,activity TEXT NOT NULL,quantity INTEGER NOT NULL CHECK(quantity>=0),occurred_at_ms INTEGER NOT NULL,evidence_ref TEXT NOT NULL,economic_key TEXT NOT NULL,counterparty_id TEXT,verified INTEGER NOT NULL CHECK(verified IN (0,1)),revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)),created_at TEXT NOT NULL DEFAULT(datetime('now')))`,
    `CREATE INDEX IF NOT EXISTS idx_v5_contribution_events_user_time ON v5_contribution_events(user_id,occurred_at_ms)`,
  ];
  for(const sql of statements)await db.prepare(sql).run();
  await db.prepare("INSERT OR IGNORE INTO v5_contribution_policy(id,version,policy_json,note) VALUES(1,0,?,'초기 설계값·신규 채굴 비활성')").bind(JSON.stringify(DEFAULT_CONTRIBUTION_POLICY)).run();
  await db.prepare('INSERT OR IGNORE INTO v5_contribution_policy_history SELECT version,policy_json,updated_by,note,updated_at FROM v5_contribution_policy WHERE id=1').run();
}
export async function readContributionPolicy(db:D1Database){
  await ensureContributionSchema(db);
  const row=await db.prepare('SELECT version,policy_json FROM v5_contribution_policy WHERE id=1').first<{version:number;policy_json:string}>();
  if(!row)throw Error('CONTRIBUTION_POLICY_MISSING');
  return {version:Number(row.version),policy:validateContributionPolicy(JSON.parse(row.policy_json))};
}
export async function saveContributionPolicy(db:D1Database,policy:ContributionPolicy,expectedVersion:number,actor:number,note:string){
  validateContributionPolicy(policy);
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0||!Number.isSafeInteger(actor)||actor<=0||!note.trim()||note.length>1000)throw Error('INVALID_CONTRIBUTION_UPDATE');
  await ensureContributionSchema(db);
  const result=await db.prepare("UPDATE v5_contribution_policy SET version=version+1,policy_json=?,updated_by=?,note=?,updated_at=datetime('now') WHERE id=1 AND version=?")
    .bind(JSON.stringify(policy),actor,note.trim(),expectedVersion).run();
  if(!result.meta.changes)throw Error('CONTRIBUTION_VERSION_CONFLICT');
  return {version:expectedVersion+1};
}
/** Internal server producer only. Include this statement in the same batch as the
 * verified business transaction; clients cannot submit scoring events through HTTP.
 * A duplicate key fails the batch; producer-level replay handles the prior transaction.
 */
export function contributionEventStatement(db:D1Database,event:ContributionEvent){
  validateContributionEvent(event);
  return db.prepare(`INSERT INTO v5_contribution_events(event_key,user_id,activity,quantity,occurred_at_ms,evidence_ref,economic_key,counterparty_id,verified,revoked) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .bind(event.eventKey,event.userId,event.activity,event.quantity,event.occurredAtMs,event.evidenceRef,event.economicKey,event.counterpartyId,event.verified?1:0,event.revoked?1:0);
}
export async function readContributionEvaluation(db:D1Database,userId:number,nowMs=Date.now()){
  if(!Number.isSafeInteger(userId)||userId<=0)throw Error('INVALID_CONTRIBUTION_USER');
  const {version,policy}=await readContributionPolicy(db);
  const rows=await db.prepare(`SELECT event_key,user_id,activity,quantity,occurred_at_ms,evidence_ref,economic_key,counterparty_id,verified,revoked FROM v5_contribution_events WHERE user_id=? AND occurred_at_ms>? AND occurred_at_ms<=? ORDER BY occurred_at_ms,event_key LIMIT 10001`)
    .bind(String(userId),nowMs-policy.windowDays*86400000,nowMs).all<{event_key:string;user_id:string;activity:ContributionEvent['activity'];quantity:number;occurred_at_ms:number;evidence_ref:string;economic_key:string;counterparty_id:string|null;verified:number;revoked:number}>();
  if(rows.results.length>10000)throw Error('CONTRIBUTION_EVENT_LIMIT_REQUIRES_AGGREGATION');
  const events=rows.results.map(r=>({eventKey:r.event_key,userId:r.user_id,activity:r.activity,quantity:r.quantity,occurredAtMs:r.occurred_at_ms,evidenceRef:r.evidence_ref,economicKey:r.economic_key,counterpartyId:r.counterparty_id,verified:r.verified===1,revoked:r.revoked===1}));
  return {policyVersion:version,newMiningEnabled:false,...evaluateContributions(events,String(userId),nowMs,policy)};
}
