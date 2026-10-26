#!/usr/bin/env node
// Actual isolated workerd/D1, with no production bindings or network requests.
const {Miniflare}=require('miniflare'),{buildSync}=require('esbuild');
const fs=require('node:fs'),assert=require('node:assert/strict');
const dir=fs.mkdtempSync('/tmp/timelink-trace-d1-');
buildSync({stdin:{contents:`export {ensureAdRewardSchema} from './src/v5-ad-reward';
export {ensureDiscovery} from './src/routes/music-discovery';
export {readRewardPolicy} from './src/v5-reward-policy';
export {putV5Object,readV5Object,deleteV5Object} from './src/v5-object-store';
export {default as admin} from './src/routes/admin';
export {readContributionPolicy,saveContributionPolicy,readContributionEvaluation} from './src/v5-contribution-store';
export {makeAccessToken} from './src/auth';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:dir+'/api.cjs',logLevel:'silent'});
async function main(){
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("isolated")}}',compatibilityDate:'2026-10-24',d1Databases:{DB:'isolated-v5-trace-d1'}});
 try{
  const db=await mf.getD1Database('DB'),api=require(dir+'/api.cjs');
  await db.prepare('CREATE TABLE tl_ads(id TEXT,status TEXT,budget_tl INTEGER,spent_tl INTEGER,completions INTEGER,updated_at TEXT)').run();
  await db.prepare('CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,is_active INTEGER,account_forfeited INTEGER)').run();
  await db.prepare("INSERT INTO users VALUES(2,'admin',1,0)").run();
  await api.ensureAdRewardSchema(db);await api.ensureDiscovery(db);await api.readRewardPolicy(db);
  const env={DB:db,JWT_SECRET:'isolated-key'},token=await api.makeAccessToken(2,env.JWT_SECRET);
  let r=await api.admin.request('/v5-work-ledger',{headers:{Authorization:'Bearer '+token}},env);assert.equal(r.status,200);
  r=await api.admin.request('/v5-work-ledger',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({expected_version:0,state:{tasks:[],events:[]}})},env);assert.equal(r.status,200);
  const history=await db.prepare('SELECT COUNT(*) n FROM v5_work_ledger_versions').first();assert.equal(history.n,1);
  const contribution=await api.readContributionPolicy(db);assert.equal(contribution.version,0);
  await api.saveContributionPolicy(db,contribution.policy,0,2,'실제 D1 정책 이력 검증');
  await assert.rejects(api.saveContributionPolicy(db,contribution.policy,0,2,'오래된 버전'),/VERSION_CONFLICT/);
  const contributionHistory=await db.prepare('SELECT COUNT(*) n FROM v5_contribution_policy_history').first();assert.equal(contributionHistory.n,2);
  assert.equal((await api.readContributionEvaluation(db,2)).index,0);
  const original=new TextEncoder().encode('private encrypted object fixture');
  await api.putV5Object(env,'private-discovery/fixture/object',original,'application/octet-stream');
  const read=await api.readV5Object(env,'private-discovery/fixture/object');assert.deepEqual(new Uint8Array(read),original);
  await api.deleteV5Object(env,'private-discovery/fixture/object');assert.equal(await api.readV5Object(env,'private-discovery/fixture/object'),null);
  console.log('PASS actual local D1: schema, complete trigger statements, work-ledger and contribution policy audit/CAS, private object fallback roundtrip');
 }finally{await mf.dispose();fs.rmSync(dir,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1});
