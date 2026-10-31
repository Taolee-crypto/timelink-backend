const fs=require('node:fs');
const assert=require('node:assert/strict');
const policy=fs.readFileSync('src/v5-reward-policy.ts','utf8');
const eco=fs.readFileSync('src/economics.ts','utf8');
const ad=fs.readFileSync('src/v5-ad-reward.ts','utf8');
const auth=fs.readFileSync('src/index.ts','utf8');
const ruleBlock=policy.match(/export const REWARD_RULES=\{([\s\S]*?)\} as const/);
assert.ok(ruleBlock,'reward catalog found');
const keys=[...ruleBlock[1].matchAll(/\b([a-z0-9_]+):\[/g)].map(x=>x[1]);
for(const obsolete of ['advertiser_signup_bonus','ad_min','ad_max','ad_default',
  'score_cap','score_share','score_use','score_view','weight_score','upload_mp3_weight']){
  assert.ok(!keys.includes(obsolete),'retired reward not in current catalog: '+obsolete);
  assert.ok(policy.includes("'"+obsolete+"'"),'retired key explicitly allowed only for old history: '+obsolete);
}
const weights=['weight_content','weight_spend','weight_listen','weight_upload'];
const vals=weights.map(k=>Number(ruleBlock[1].match(new RegExp('\\b'+k+':\\[([0-9.]+)'))?.[1]));
assert.ok(vals.every(Number.isFinite));
assert.ok(Math.abs(vals.reduce((a,b)=>a+b,0)-1)<1e-9,'active weights sum to one');
assert.ok(policy.includes('INVALID_REWARD_POLICY_KEYS'),'unknown persisted keys fail closed');
assert.ok(!eco.includes('policy.weight_score'),'mining no longer counts sheet views');
assert.ok(!eco.includes('scoreScore'),'removed score from reward calculation');
assert.ok(eco.includes("code:'AD_REWARD_RETIRED'"),'deprecated endpoints respond as retired');
assert.equal((eco.match(/AD_REWARD_RETIRED/g)||[]).length,2);
assert.ok(!/ad_campaign_issuance|postLedgerTransaction/.test(ad),'legacy grant helper cannot issue TL_A');
assert.ok(ad.includes("throw new Error('AD_REWARD_RETIRED')"));
assert.ok(!auth.includes('rewardRules.advertiser_signup_bonus'),'advertiser no longer receives special signup reward');
const sales=fs.readFileSync('src/sales-managers.ts','utf8');
const salesRouter=fs.readFileSync('src/routes/sales-managers.ts','utf8');
const djRouter=fs.readFileSync('src/routes/dj-cafe.ts','utf8');
const incar=fs.readFileSync('src/incar-promotion-policy.ts','utf8');
const cashout=fs.readFileSync('src/v5-cashout.ts','utf8');
for(const name of ['signSalesContract','simulateSalesDeposit','assignmentPlan','settleCafeService','chargeCafeStream']){
 const start=sales.indexOf('export async function '+name+'(');
 assert.ok(start>=0,'old sales function retained for historic compatibility: '+name);
 assert.ok(sales.slice(start,start+620).includes("throw Error('RETIRED_SALES_MANAGER_DJ')"),'must stop new sales/DJ finances: '+name);
}
assert.ok(salesRouter.includes("error:'RETIRED_SALES_MANAGER_DJ'"),'sales router refuses new onboarding/billing');
assert.ok(djRouter.includes("error:'RETIRED_DJ_BROADCAST'"),'DJ router refuses new sessions');
const djBonus=djRouter.slice(djRouter.indexOf('async function grantBonus('),djRouter.indexOf('// ── GET /api/dj-cafe/bonus-config'));
assert.ok(djBonus.includes('return null')&&!djBonus.includes('UPDATE users'),'DJ bonuses cannot mutate balances');
assert.ok(incar.includes("throw new Error('RETIRED_DJ_PROMOTION_CHANNEL')"),'in-car DJ promotion cannot be newly rewarded');
assert.ok(eco.includes('tl_b = tl_b + ?'),'legacy TL_B creator reward must retain TL_B');
assert.ok(eco.includes('const uploads = tl3Count * policy.upload_tl3_weight'),'unreleased MP3 inputs do not earn PoC');
assert.ok(cashout.includes('livePurchasedWalletAtoms')&&cashout.includes('paidAccountSnapshot'),'listener cashout must have real purchased-funds provenance');
console.log('PASS retired DJ/manager endpoints, creator TL_B provenance, paid-only cashout and MP3 score removal');
console.log('PASS: deleted reward types cannot be configured or issued by retired routes; legacy policy read compatibility preserved');
