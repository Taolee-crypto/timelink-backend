/**
 * V5 profit and reward-sustainability guard.
 *
 * Development-stage behavior: manual policy changes ONLY.
 * Scenarios are estimates, NOT verified revenue or bank settlement.
 * Never update V5 reward policy, TL/TLC balances, settlement or prices here.
 */
export type ProfitSafetyLimits={
 min_margin_bps:number;
 max_benefits_percent:number;
 monthly_liability_ceiling_krw:number;
};
export type ProfitSafetyScenario={
 gross_krw:number;refund_krw:number;pg_fees_krw:number;rights_krw:number;
 infrastructure_krw:number;marketing_krw:number;other_krw:number;
 tl_b_expected_redemption_krw:number;tlc_reserve_krw:number;
};
export const DEFAULT_PROFIT_SAFETY_LIMITS:ProfitSafetyLimits={
 min_margin_bps:1000,max_benefits_percent:25,monthly_liability_ceiling_krw:100000000
};
export function validateProfitSafetyLimits(v:any):ProfitSafetyLimits{
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==
   Object.keys(DEFAULT_PROFIT_SAFETY_LIMITS).sort().join(','))throw Error('INVALID_PROFIT_LIMIT_KEYS');
 if(!Number.isSafeInteger(v.min_margin_bps)||v.min_margin_bps<0||v.min_margin_bps>10000)throw Error('INVALID_MIN_MARGIN');
 if(typeof v.max_benefits_percent!=='number'||!Number.isFinite(v.max_benefits_percent)||
    v.max_benefits_percent<0||v.max_benefits_percent>100)throw Error('INVALID_BENEFIT_RATIO');
 if(!Number.isSafeInteger(v.monthly_liability_ceiling_krw)||v.monthly_liability_ceiling_krw<0||
    v.monthly_liability_ceiling_krw>1000000000000)throw Error('INVALID_LIABILITY_CEILING');
 return v as ProfitSafetyLimits;
}
const COSTS=['refund_krw','pg_fees_krw','rights_krw','infrastructure_krw','marketing_krw','other_krw',
 'tl_b_expected_redemption_krw','tlc_reserve_krw'] as const;
const SCENARIO_KEYS=['gross_krw',...COSTS];
export function evaluateProfitSafety(input:any,limits:ProfitSafetyLimits){
 validateProfitSafetyLimits(limits);
 if(!input||typeof input!=='object'||Array.isArray(input)||
  Object.keys(input).sort().join(',')!==[...SCENARIO_KEYS].sort().join(','))
  throw Error('INVALID_PROFIT_SCENARIO');
 for(const key of SCENARIO_KEYS){
  if(typeof input[key]!=='number'||!Number.isSafeInteger(input[key])||input[key]<0||input[key]>1000000000000)
   throw Error('INVALID_PROFIT_AMOUNT:'+key);
 }
 const x=input as ProfitSafetyScenario;
 const expense=COSTS.reduce((sum,key)=>sum+x[key],0);
 const benefitCost=x.tl_b_expected_redemption_krw+x.tlc_reserve_krw;
 const contribution=x.gross_krw-expense;
 const margin=x.gross_krw>0?contribution/x.gross_krw:null;
 const benefitRatio=x.gross_krw>0?benefitCost/x.gross_krw:null;
 const alerts:string[]=[];
 if(x.gross_krw===0)alerts.push('NO_VERIFIED_REVENUE_INPUT');
 if(benefitCost>limits.monthly_liability_ceiling_krw)alerts.push('INCENTIVE_CEILING_EXCEEDED');
 if(x.gross_krw>0&&benefitRatio!==null&&benefitRatio*100>limits.max_benefits_percent)
  alerts.push('INCENTIVE_RATIO_EXCEEDED');
 if(x.gross_krw>0&&margin!==null&&margin*10000<limits.min_margin_bps)
  alerts.push('MIN_MARGIN_BREACHED');
 return {ok:true,kind:'scenario_not_verified',currency:'KRW',income_krw:x.gross_krw,
  total_cost_krw:expense,contribution_krw:contribution,estimated_margin_percent:margin===null?null:Number((margin*100).toFixed(4)),
  incentive_krw:benefitCost,incentive_percent:benefitRatio===null?null:Number((benefitRatio*100).toFixed(4)),
  assessment:alerts.length?'blocked':'modeled_within_limits',alerts,limits,
  reward_policy_modified:false,auto_optimizer_enabled:false,
  evidence_required:['real_bank_settlement','confirmed_refunds','rights_holder_payables','monthly_infrastructure_actuals']};
}
export async function ensureProfitSafetyControls(db:D1Database){
 await db.prepare(`CREATE TABLE IF NOT EXISTS v5_profit_safety_controls(
  id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL DEFAULT 0,
  mode TEXT NOT NULL DEFAULT 'manual' CHECK(mode='manual'),
  limits_json TEXT NOT NULL,updated_by INTEGER,updated_at TEXT DEFAULT(datetime('now')))`).run();
 await db.prepare(`INSERT OR IGNORE INTO v5_profit_safety_controls(id,version,mode,limits_json)
    VALUES(1,0,'manual',?)`).bind(JSON.stringify(DEFAULT_PROFIT_SAFETY_LIMITS)).run();
 await db.prepare(`CREATE TABLE IF NOT EXISTS v5_profit_safety_history(
  version INTEGER PRIMARY KEY,limits_json TEXT NOT NULL,updated_by INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK(mode='manual'),updated_at TEXT NOT NULL DEFAULT(datetime('now')))`).run();
 await db.prepare(`CREATE TRIGGER IF NOT EXISTS v5_profit_safety_audit
  AFTER UPDATE ON v5_profit_safety_controls
  BEGIN INSERT INTO v5_profit_safety_history(version,limits_json,updated_by,mode)
  VALUES(NEW.version,NEW.limits_json,NEW.updated_by,NEW.mode); END`).run();
}
export async function readProfitSafetyControls(db:D1Database){
 await ensureProfitSafetyControls(db);
 const row=await db.prepare('SELECT version,mode,limits_json,updated_at FROM v5_profit_safety_controls WHERE id=1').first<any>();
 return {version:Number(row.version),mode:'manual' as const,
  limits:validateProfitSafetyLimits(JSON.parse(row.limits_json)),updated_at:row.updated_at,
  auto_optimizer_enabled:false,approval_required:true,
  readiness:'unverified_financial_inputs',verified_profitability:false};
}
export async function saveProfitSafetyLimits(db:D1Database,operator:number,version:number,limits:any){
 if(!Number.isSafeInteger(operator)||operator<=0)throw Error('ADMIN_ID_REQUIRED');
 if(!Number.isSafeInteger(version)||version<0)throw Error('EXPECTED_VERSION_REQUIRED');
 const validated=validateProfitSafetyLimits(limits);
 await ensureProfitSafetyControls(db);
 const saved=await db.prepare("UPDATE v5_profit_safety_controls SET version=version+1,limits_json=?,updated_by=?,updated_at=datetime('now') WHERE id=1 AND version=? AND mode='manual'")
 .bind(JSON.stringify(validated),operator,version).run();
 if(!saved.meta?.changes)throw Error('PROFIT_SAFETY_VERSION_CONFLICT');
 return {ok:true,version:version+1,mode:'manual',auto_optimizer_enabled:false};
}
export async function readProfitSafetyHistory(db:D1Database){
 await ensureProfitSafetyControls(db);
 const rows=await db.prepare('SELECT version,updated_by,mode,updated_at,limits_json FROM v5_profit_safety_history ORDER BY version DESC LIMIT 50').all<any>();
 return (rows.results||[]).map(r=>({version:Number(r.version),updated_by:Number(r.updated_by),updated_at:r.updated_at,mode:'manual',limits:validateProfitSafetyLimits(JSON.parse(r.limits_json))}));
}
