'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{buildSync}=require('esbuild');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tl3-local-lookup-'));
const output=path.join(dir,'route.cjs');
buildSync({stdin:{contents:"export {default as router} from './src/routes/tl3-v5';export {makeAccessToken} from './src/auth';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:output,logLevel:'silent'});
const api=require(output),sql=new DatabaseSync(':memory:');
sql.exec(`
CREATE TABLE users(id INTEGER PRIMARY KEY,is_active INTEGER,account_forfeited INTEGER);
INSERT INTO users VALUES(7,1,0),(8,0,0);
CREATE TABLE tl3_v5_releases(file_id INTEGER,user_id INTEGER,share_id TEXT,container_sha256 TEXT,status TEXT);
CREATE TABLE tl_files(id INTEGER,shared INTEGER,file_type TEXT,revenue_held INTEGER);
CREATE TABLE tl_creator_metadata(file_id INTEGER,user_id INTEGER,rights_declared INTEGER,rights_role TEXT,rights_scope TEXT,declaration_status TEXT);
INSERT INTO tl_files VALUES(147,1,'audio/tl3',0);
INSERT INTO tl_creator_metadata VALUES(147,7,1,'owner','master_recording','approved');
`);
const sha='a'.repeat(64);
sql.prepare("INSERT INTO tl3_v5_releases VALUES(147,7,'tl3_147',?,'sealed')").run(sha);
let mutations=0;
const db={prepare(query){let args=[];const st={bind(...values){args=values;return st},async first(){return sql.prepare(query).get(...args)||null},async all(){return {results:sql.prepare(query).all(...args)}},async run(){mutations++;return sql.prepare(query).run(...args)}};return st;}};
const env={DB:db,JWT_SECRET:'fixture-auth-local-tl3-v5'};
async function run(){
  const token=await api.makeAccessToken(7,env.JWT_SECRET);
  const disabled=await api.makeAccessToken(8,env.JWT_SECRET);
  const url=h=>'/resolve-by-container/'+h;
  async function check(hash,bearer,expected){
    const response=await api.router.request(url(hash),{headers:bearer?{Authorization:'Bearer '+bearer}:{}},env);
    assert.equal(response.status,expected,'container '+hash.slice(0,8));
    return response.json();
  }
  assert.equal((await check(sha,null,401)).ok,false);
  assert.equal((await check(sha,disabled,401)).ok,false);
  assert.equal((await check('bogus',token,400)).ok,false);
  assert.equal((await check('b'.repeat(64),token,404)).ok,false);
  const result=await check(sha,token,200);
  assert.deepEqual({file_id:result.file_id,share_id:result.share_id,version:result.version},{file_id:147,share_id:'tl3_147',version:5});
  assert.equal(result.wrapped_license,undefined);
  assert.equal(result.container_sha256,undefined,'avoid relaying raw encrypted blob hash to client unnecessarily');
  sql.exec("UPDATE tl_files SET shared=0");await check(sha,token,404);sql.exec("UPDATE tl_files SET shared=1,revenue_held=1");await check(sha,token,404);
  sql.exec("UPDATE tl_files SET revenue_held=0");
  sql.exec("UPDATE tl_creator_metadata SET declaration_status='rejected'");await check(sha,token,404);
  sql.exec("UPDATE tl_creator_metadata SET declaration_status='approved'");
  sql.exec("UPDATE tl3_v5_releases SET status='revoked'");await check(sha,token,404);
  assert.equal(mutations,0,'lookup must not credit TL, unwrap license or mutate playback/rights state');
  console.log('PASS TL3 V5 authenticated local-container SHA256 lookup: published sealed rights only, no keys or wallet mutations, all deny paths');
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{sql.close();fs.rmSync(dir,{recursive:true,force:true});});
