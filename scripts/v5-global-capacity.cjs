'use strict';
/**
 * TimeLink V5: regional demand and Cloudflare operating-cost model.
 * Synthetic deterministic forecast, NOT an actual regional load test or invoice.
 * Pricing sources reviewed 2026-10-29:
 * https://developers.cloudflare.com/workers/platform/pricing/
 * https://developers.cloudflare.com/d1/platform/pricing/
 * https://developers.cloudflare.com/r2/pricing/
 * Production network, inference, rights, PG and non-Cloudflare costs are excluded.
 */
const REGIONS=Object.freeze([
 {country:'KR',label:'Korea',share:0.35,utcOffset:9},
 {country:'JP',label:'Japan',share:0.16,utcOffset:9},
 {country:'US',label:'US Eastern (model)',share:0.25,utcOffset:-5},
 {country:'CN',label:'China',share:0.10,utcOffset:8},
 {country:'TH',label:'Thailand',share:0.07,utcOffset:7},
 {country:'VN',label:'Vietnam',share:0.07,utcOffset:7}
]);
const RATES=Object.freeze({
 workersPlanUsd:5,workersRequestsIncluded:10000000,workersRequestUsdPerMillion:0.30,
 workersCpuMsIncluded:30000000,workersCpuUsdPerMillionMs:0.02,
 d1RowsReadIncluded:25000000000,d1RowsReadUsdPerMillion:0.001,
 d1RowsWrittenIncluded:50000000,d1RowsWrittenUsdPerMillion:1.00,
 r2ReadIncluded:10000000,r2ReadUsdPerMillion:0.36,
 r2WriteIncluded:1000000,r2WriteUsdPerMillion:4.50,
 r2StorageGbIncluded:10,r2StorageUsdPerGb:0.015
});
const DEFAULT=Object.freeze({
 mau:1000000,daysPerMonth:30,dauRatio:0.18,apiRequestsPerDau:40,
 workerCpuMsPerRequest:7,d1RowsReadPerRequest:12,d1RowsWrittenPerRequest:1.1,
 r2ClassBReadsPerRequest:0.40,r2ClassAWritesPerDau:0.06,
 baseStorageGb:30,storageGbPerThousandMau:0.025,
 monthlyBudgetUsd:100,assumedPeakCapacityRps:300,meanRequestWallTimeMs:250
});
function assertInput(p){
 const keys=Object.keys(DEFAULT);
 if(!p||typeof p!=='object'||Object.keys(p).some(k=>!keys.includes(k)))throw Error('UNKNOWN_CAPACITY_INPUT');
 for(const k of keys){if(typeof p[k]!=='number'||!Number.isFinite(p[k])||p[k]<0)throw Error('INVALID_CAPACITY_INPUT:'+k);}
 if(!Number.isSafeInteger(p.mau)||p.mau<1||p.dauRatio>1||p.daysPerMonth<1||
    p.assumedPeakCapacityRps<=0||p.meanRequestWallTimeMs<=0)throw Error('INVALID_CAPACITY_SCENARIO');
 const sum=REGIONS.reduce((n,r)=>n+r.share,0);if(Math.abs(sum-1)>1e-12)throw Error('INVALID_REGION_SHARES');
}
const positive=n=>Math.max(0,n);
const dollars=n=>Number(n.toFixed(4));
function costModel(m,r=RATES){
 const million=1000000;
 const lines={
  workers_plan:r.workersPlanUsd,
  workers_requests:positive(m.requests-r.workersRequestsIncluded)/million*r.workersRequestUsdPerMillion,
  workers_cpu:positive(m.cpuMs-r.workersCpuMsIncluded)/million*r.workersCpuUsdPerMillionMs,
  d1_reads:positive(m.d1Reads-r.d1RowsReadIncluded)/million*r.d1RowsReadUsdPerMillion,
  d1_writes:positive(m.d1Writes-r.d1RowsWrittenIncluded)/million*r.d1RowsWrittenUsdPerMillion,
  r2_reads:positive(m.r2Reads-r.r2ReadIncluded)/million*r.r2ReadUsdPerMillion,
  r2_writes:positive(m.r2Writes-r.r2WriteIncluded)/million*r.r2WriteUsdPerMillion,
  r2_storage:positive(m.storageGb-r.r2StorageGbIncluded)*r.r2StorageUsdPerGb
 };
 return {components:Object.fromEntries(Object.entries(lines).map(([k,v])=>[k,dollars(v)])),
  monthlyUsd:dollars(Object.values(lines).reduce((a,b)=>a+b,0)),
  note:'Paid Workers Standard model; usage allowances are account-wide, not per country'};
}
function simulate(input={}){
 const p={...DEFAULT,...input};assertInput(p);
 const dayActive=p.mau*p.dauRatio;
 const dailyRequests=dayActive*p.apiRequestsPerDau;
 const monthlyRequests=dailyRequests*p.daysPerMonth;
 const hourFactors=Array.from({length:24},(_,h)=>h>=19&&h<=21?4:h>=17&&h<=23?2:1);
 const sumFactors=hourFactors.reduce((a,b)=>a+b,0);
 const hourly=Array.from({length:24},(_,hourUTC)=>{
  const byCountry=REGIONS.map(r=>{
   const localHour=(hourUTC+r.utcOffset+24)%24;
   return {country:r.country,rps:dailyRequests*r.share*hourFactors[localHour]/sumFactors/3600};
  });
  return {utcHour:hourUTC,rps:byCountry.reduce((sum,r)=>sum+r.rps,0),byCountry};
 });
 const peak=hourly.reduce((a,b)=>b.rps>a.rps?b:a);
 const metrics={
  requests:monthlyRequests,cpuMs:monthlyRequests*p.workerCpuMsPerRequest,
  d1Reads:monthlyRequests*p.d1RowsReadPerRequest,
  d1Writes:monthlyRequests*p.d1RowsWrittenPerRequest,
  r2Reads:monthlyRequests*p.r2ClassBReadsPerRequest,
  r2Writes:dayActive*p.daysPerMonth*p.r2ClassAWritesPerDau,
  storageGb:p.baseStorageGb+(p.mau/1000)*p.storageGbPerThousandMau
 };
 const costs=costModel(metrics);
 const regions=REGIONS.map(r=>({
  country:r.country,label:r.label,modeledMau:Math.round(p.mau*r.share),
  monthlyApiRequests:Math.round(monthlyRequests*r.share),
  peakLocalRps:Number((dailyRequests*r.share*4/sumFactors/3600).toFixed(3)),
  variableUsageShareUsd:dollars((costs.monthlyUsd-RATES.workersPlanUsd)*r.share)
 }));
 return {
  kind:'scenario_not_measured',asOf:'2026-10-29',
  assumptions:p,countryShares:regions,
  worldwidePeakUTC:peak.utcHour,
  worldwidePeakRps:Number(peak.rps.toFixed(3)),
  modeledConcurrency:Number((peak.rps*p.meanRequestWallTimeMs/1000).toFixed(2)),
  assumedCapacityRps:p.assumedPeakCapacityRps,
  modeledUtilization:Number((peak.rps/p.assumedPeakCapacityRps).toFixed(4)),
  metrics,estimatedCosts:costs,
  alerts:[
   ...(peak.rps>p.assumedPeakCapacityRps?['EXCEEDS_ASSUMED_RPS_CAPACITY']:[]),
   ...(costs.monthlyUsd>p.monthlyBudgetUsd?['EXCEEDS_MODELED_MONTHLY_BUDGET']:[])
  ],
  caveats:[
   'No live load is sent to production. Real latency, CPU, cache-hit and D1 read/write statistics must replace assumed rates.',
   'US represents one timezone; real rollout needs regional subdivision and DST calendar.',
   'Cloudflare account tier and custom contracts may differ. Prices exclude PG, AI, TON, staffing, royalty, legal and marketing.',
   'R2 Standard storage only; no egress charge for direct R2 as documented.'
  ]
 };
}
if(require.main===module){
 const flags=Object.fromEntries(process.argv.slice(2).filter(v=>v.startsWith('--')).map(v=>v.slice(2).split('=')));
 const mau=flags.mau?Number(flags.mau):DEFAULT.mau;
 const budget=flags.budget?Number(flags.budget):DEFAULT.monthlyBudgetUsd;
 const rps=flags['rps-limit']?Number(flags['rps-limit']):DEFAULT.assumedPeakCapacityRps;
 const result=simulate({mau,monthlyBudgetUsd:budget,assumedPeakCapacityRps:rps});
 console.log(JSON.stringify(result,null,2));
 if(flags['fail-on-alert']==='true'&&result.alerts.length)process.exitCode=2;
}
module.exports={REGIONS,RATES,DEFAULT,costModel,simulate};
