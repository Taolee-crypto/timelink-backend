// Explicit operator-controlled rules. There is no automatic optimizer.
export const REWARD_RULES={
  signup_bonus:[42500,0,1000000,'일반 가입 TL_B'],
  // Disabled TL_B grants by default until an operator explicitly budgets them.
  referral_signup_tl_b:[0,0,100000,'추천 회원 인증 후 TL_B'],
  referral_store_tl_b:[0,0,100000,'추천 매장 첫 검증 결제 후 TL_B'],
  referral_signup_poc:[0.2,0,5,'추천 회원 인증 POC'],
  referral_store_poc:[0.5,0,5,'추천 매장 검증 결제 POC'],
  referral_poc_cap:[1,0,5,'추천 월간 POC 가산 상한'],
  exchange_min:[1000,1,1000000,'일반 환전 최소 TL_P'],fee_a:[0.05,0,1,'플랜 A 환전 수수료율'],fee_b:[0.03,0,1,'플랜 B 환전 수수료율'],
  mining_rate:[0.08,0,1,'TLC 채굴 기본 비율'],mining_month_cap:[0.30,0,1,'TLC 월 소비 대비 상한'],plan_b_multiplier:[2,0,10,'플랜 B 채굴 배수'],
  content_cap:[2,0,5,'재생 기여 점수 상한'],content_target:[500,1,1000000,'재생 기여 기준 횟수'],
  spend_cap:[1.5,0,5,'소비 기여 점수 상한'],spend_target:[5000,1,10000000,'소비 기여 기준 TL_P'],
  listen_cap:[1,0,5,'청취 기여 점수 상한'],listen_target:[30,1,10000,'청취 기여 기준 시간'],
  upload_cap:[0.5,0,5,'업로드 기여 점수 상한'],upload_target:[5,1,10000,'업로드 기여 기준 건수'],
  upload_tl3_weight:[3,0,10,'TL3 업로드 가중치'],
  weight_content:[0.40,0,1,'POC 재생 비중'],weight_spend:[0.30,0,1,'POC 소비 비중'],weight_listen:[0.20,0,1,'POC 청취 비중'],weight_upload:[0.10,0,1,'POC 업로드 비중'],
  poc_scale:[10,0.1,100,'POC 환산 배수'],poc_min:[0.1,0.1,5,'POC 최솟값'],poc_max:[5,0.1,5,'POC 최댓값'],
  bonus_5000:[0,0,1000000,'5,000원 충전 TL_B'],bonus_10000:[500,0,1000000,'10,000원 충전 TL_B'],bonus_30000:[2000,0,1000000,'30,000원 충전 TL_B'],bonus_50000:[5000,0,1000000,'50,000원 충전 TL_B'],bonus_100000:[15000,0,1000000,'100,000원 충전 TL_B'],
} as const;
export type RewardRules=Record<keyof typeof REWARD_RULES,number>;
export const DEFAULT_REWARD_RULES=Object.fromEntries(Object.entries(REWARD_RULES).map(([k,v])=>[k,v[0]])) as RewardRules;
export async function ensureRewardPolicy(db:D1Database){
  await db.prepare('CREATE TABLE IF NOT EXISTS v5_signup_entitlements(user_id INTEGER PRIMARY KEY,bonus_tl INTEGER NOT NULL,policy_version INTEGER NOT NULL)').run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS v5_reward_policy(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,rules_json TEXT NOT NULL,updated_by INTEGER,updated_at TEXT)`
  ).run();
  await db.prepare('INSERT OR IGNORE INTO v5_reward_policy(id,version,rules_json) VALUES(1,0,?)').bind(JSON.stringify(DEFAULT_REWARD_RULES)).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS v5_reward_policy_history(version INTEGER PRIMARY KEY,rules_json TEXT NOT NULL,updated_by INTEGER NOT NULL,note TEXT NOT NULL,updated_at TEXT DEFAULT(datetime('now')))`
  ).run();
  await db.prepare(`CREATE TRIGGER IF NOT EXISTS v5_reward_policy_audit AFTER UPDATE ON v5_reward_policy
    BEGIN INSERT INTO v5_reward_policy_history(version,rules_json,updated_by,note) VALUES(NEW.version,NEW.rules_json,NEW.updated_by,'관리자 수동 승인'); END`).run();
}
export function validateRewardRules(input:any):RewardRules{
  if(!input||Object.keys(input).length!==Object.keys(REWARD_RULES).length)throw new Error('모든 보상 규칙을 입력해야 합니다.');
  for(const [key,[,min,max]] of Object.entries(REWARD_RULES)){
    const value=input[key];if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error('보상 규칙 범위를 확인하세요: '+key);
    if((key.includes('bonus')||key==='exchange_min')&&!Number.isSafeInteger(value))throw new Error('TL 지급량은 정수여야 합니다.');
  }
  if(input.poc_min>input.poc_max)throw new Error('보상 규칙의 최솟값·최댓값을 확인하세요.');
  const weight=['content','spend','listen','upload'].reduce((n,k)=>n+input['weight_'+k],0);
  if(Math.abs(weight-1)>0.000001)throw new Error('POC 비중 합계는 1이어야 합니다.');
  return input as RewardRules;
}
/** Retired rewards remain only in historical policy JSON and audit logs.
 * Never re-enable advertising or score incentives from old saved settings.
 */
export const RETIRED_REWARD_RULE_KEYS = [
  'advertiser_signup_bonus','ad_min','ad_max','ad_default',
  'score_cap','score_share','score_use','score_view','weight_score','upload_mp3_weight'
] as const;
const retiredRewardKeys = new Set<string>(RETIRED_REWARD_RULE_KEYS);

/** Read old policy versions without rewriting historical rows.
 * Reweight the four surviving PoC categories proportionally on old policies.
 * An unexpected key still fails closed, rather than silently accepting typos.
 */
export function validateStoredRewardRules(stored:any):RewardRules{
  if(!stored||typeof stored!=='object'||Array.isArray(stored)||
    Object.keys(stored).some(key=>!(key in REWARD_RULES)&&!retiredRewardKeys.has(key)))
    throw Error('INVALID_REWARD_POLICY_KEYS');
  const active=Object.fromEntries(Object.entries(stored).filter(([key])=>key in REWARD_RULES));
  if('weight_score' in stored){
    const keys=['content','spend','listen','upload'];
    const sum=keys.reduce((n,key)=>n+Number(active['weight_'+key]??DEFAULT_REWARD_RULES['weight_'+key as keyof RewardRules]),0);
    if(!Number.isFinite(sum)||sum<=0)throw Error('INVALID_LEGACY_POC_WEIGHTS');
    for(const key of keys){
      const weightKey='weight_'+key;
      active[weightKey]=Number(active[weightKey]??DEFAULT_REWARD_RULES[weightKey as keyof RewardRules])/sum;
    }
  }
  return validateRewardRules({...DEFAULT_REWARD_RULES,...active});
}
export async function readRewardPolicy(db:D1Database){
  await ensureRewardPolicy(db);
  const row=await db.prepare('SELECT version,rules_json FROM v5_reward_policy WHERE id=1').first<any>();
  return {version:Number(row.version),rules:validateStoredRewardRules(JSON.parse(row.rules_json))};
}
export function paymentBonusMap(rules:RewardRules):Record<number,number>{
  return {5000:rules.bonus_5000,10000:rules.bonus_10000,30000:rules.bonus_30000,50000:rules.bonus_50000,100000:rules.bonus_100000};
}
