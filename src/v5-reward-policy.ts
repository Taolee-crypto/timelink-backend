// Explicit operator-controlled rules. There is no automatic optimizer.
export const REWARD_RULES={
  signup_bonus:[42500,0,1000000,'일반 가입 TL_B'],advertiser_signup_bonus:[300000,0,1000000,'광고주 가입 TL_B'],
  ad_min:[50,1,100000,'광고 최소 TL_A'],ad_max:[1000,1,100000,'광고 최대 TL_A'],ad_default:[300,1,100000,'광고 기본 TL_A'],
  exchange_min:[1000,1,1000000,'일반 환전 최소 TL_P'],fee_a:[0.05,0,1,'플랜 A 환전 수수료율'],fee_b:[0.03,0,1,'플랜 B 환전 수수료율'],
  mining_rate:[0.08,0,1,'TLC 채굴 기본 비율'],mining_month_cap:[0.30,0,1,'TLC 월 소비 대비 상한'],plan_b_multiplier:[2,0,10,'플랜 B 채굴 배수'],
  content_cap:[2,0,5,'재생 기여 점수 상한'],content_target:[500,1,1000000,'재생 기여 기준 횟수'],
  spend_cap:[1.5,0,5,'소비 기여 점수 상한'],spend_target:[5000,1,10000000,'소비 기여 기준 TL_P'],
  listen_cap:[1,0,5,'청취 기여 점수 상한'],listen_target:[30,1,10000,'청취 기여 기준 시간'],
  upload_cap:[0.5,0,5,'업로드 기여 점수 상한'],upload_target:[5,1,10000,'업로드 기여 기준 건수'],
  upload_mp3_weight:[1,0,10,'일반 업로드 가중치'],upload_tl3_weight:[3,0,10,'TL3 업로드 가중치'],
  score_cap:[0.6,0,5,'악보 기여 점수 상한'],score_share:[0.3,0,5,'악보 공유 점수'],score_use:[0.05,0,5,'악보 사용 점수'],score_view:[0.005,0,5,'악보 조회 점수'],
  weight_content:[0.35,0,1,'POC 재생 비중'],weight_spend:[0.25,0,1,'POC 소비 비중'],weight_listen:[0.18,0,1,'POC 청취 비중'],weight_upload:[0.10,0,1,'POC 업로드 비중'],weight_score:[0.12,0,1,'POC 악보 비중'],
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
    if((key.includes('bonus')||key.startsWith('ad_')||key==='exchange_min')&&!Number.isSafeInteger(value))throw new Error('TL 지급량은 정수여야 합니다.');
  }
  if(input.ad_min>input.ad_default||input.ad_default>input.ad_max||input.poc_min>input.poc_max)throw new Error('보상 규칙의 최솟값·최댓값을 확인하세요.');
  const weight=['content','spend','listen','upload','score'].reduce((n,k)=>n+input['weight_'+k],0);
  if(Math.abs(weight-1)>0.000001)throw new Error('POC 비중 합계는 1이어야 합니다.');
  return input as RewardRules;
}
export async function readRewardPolicy(db:D1Database){
  await ensureRewardPolicy(db);
  const row=await db.prepare('SELECT version,rules_json FROM v5_reward_policy WHERE id=1').first<any>();
  return {version:Number(row.version),rules:validateRewardRules(JSON.parse(row.rules_json))};
}
export function paymentBonusMap(rules:RewardRules):Record<number,number>{
  return {5000:rules.bonus_5000,10000:rules.bonus_10000,30000:rules.bonus_30000,50000:rules.bonus_50000,100000:rules.bonus_100000};
}
