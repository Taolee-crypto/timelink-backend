'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{buildSync}=require('esbuild');
const {createHash}=require('node:crypto');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'timelink-private-creator-'));
const bundle=path.join(temp,'creator.cjs');
buildSync({stdin:{contents:"export {default as discovery,ensureDiscovery} from './src/routes/music-discovery';export {makeAccessToken} from './src/auth';",resolveDir:process.cwd(),loader:'ts'},outfile:bundle,format:'cjs',platform:'node',bundle:true,logLevel:'silent'});
const api=require(bundle),sql=new DatabaseSync(':memory:');
sql.exec("CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT,is_active INTEGER DEFAULT 1,account_forfeited INTEGER DEFAULT 0);INSERT INTO users(id,email) VALUES(7,'owner@example.test'),(8,'other@example.test')");
const db={async exec(statement){sql.exec(statement);return {count:0,duration:0}},prepare(query){let args=[];const statement={bind(...p){args=p;return statement},async first(){return sql.prepare(query).get(...args)||null},async all(){return {results:sql.prepare(query).all(...args)}},async run(){return sql.prepare(query).run(...args)}};return statement;},async batch(items){sql.exec('BEGIN IMMEDIATE');try{const results=[];for(const x of items)results.push(await x.run());sql.exec('COMMIT');return results}catch(e){sql.exec('ROLLBACK');throw e}}};
const stored=new Map(),writes=[];
const r2={
 async put(key,body,options){stored.set(key,new Uint8Array(body));writes.push({action:'put',key,contentType:options?.httpMetadata?.contentType});},
 async delete(key){stored.delete(key);writes.push({action:'delete',key});}
};
const env={DB:db,JWT_SECRET:'isolated-creator-duplicates-jwt-test',STORAGE_ENCRYPTION_KEY:'isolated-existing-secret-raw',R2:r2};
function digest(data){return createHash('sha256').update(data).digest('hex');}
function fileFromText(text,name='demo.mp3'){return new File([Buffer.from(text)],name,{type:'audio/mpeg'});}
async function send(id,form,token){
 const req=new Request('https://fixture.invalid/',{method:'POST',headers:token?{Authorization:'Bearer '+token}:{},body:form});
 const resp=await api.discovery.request(req,{},env);
 return {status:resp.status,body:await resp.json()};
}
function makeForm(file,batch='batch_private_2026'){
 const body=new FormData();body.append('file',file);body.append('batch_id',batch);body.append('title','검증 음악');body.append('artist','등록자');
 body.append('metadata',JSON.stringify({rights_role:'recording_owner',acknowledgement:'pending_manual_verification'}));
 return body;
}
async function main(){
 const owner=await api.makeAccessToken(7,env.JWT_SECRET);
 const other=await api.makeAccessToken(8,env.JWT_SECRET);
 const raw='isolated-music-test-binary-content-a';
 let r=await send(7,makeForm(fileFromText(raw)),null);
 assert.equal(r.status,401,'unauthenticated upload cannot create private registrations');
 assert.equal(stored.size,0);
 r=await send(7,makeForm(fileFromText(raw)),owner);
 assert.equal(r.status,201,JSON.stringify(r.body));
 assert.equal(r.body.replayed,false);
 assert.equal(r.body.registration.status,'pending_rights','submission is NOT a rights approval');
 assert.match(r.body.note,/권리 검토 승인 전에는 공개 재생·수익 지급이 이뤄지지 않습니다/);
 const first=sql.prepare('SELECT * FROM v5_music_discovery WHERE user_id=7').get();
 assert.equal(first.sha256,digest(raw),'source material must have exact SHA256');
 assert.equal(first.status,'pending_rights');
 assert.match(first.storage_key,/^private-discovery\/7\//);
 assert.equal(first.key_source,'STORAGE_ENCRYPTION_KEY');
 assert.ok(stored.has(first.storage_key));
 assert.notEqual(Buffer.from(stored.get(first.storage_key)).toString('utf8'),raw,'object storage must never retain plaintext');
 const firstWrites=stored.size;
 r=await send(7,makeForm(fileFromText(raw)),owner);
 assert.equal(r.status,200);
 assert.equal(r.body.replayed,true,'identical audio is replayed under same verified account');
 assert.equal(r.body.registration.id,first.id);
 assert.equal(stored.size,firstWrites,'replay cannot create another encrypted asset');
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_music_discovery WHERE user_id=7').get().n,1);
 r=await send(8,makeForm(fileFromText(raw)),other);
 assert.equal(r.status,201,'other users can only submit a private review claim, never get licensed from collision');
 assert.equal(r.body.registration.status,'pending_rights');
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_music_discovery WHERE user_id=8').get().n,1);
 const response=await api.discovery.request(new Request('https://fixture.invalid/',{headers:{Authorization:'Bearer '+owner}}),{},env);
 const list=await response.json();
 assert.equal(response.status,200);
 assert.equal(list.registrations.length,1,'review list must exclude the other account claim');
 assert.equal(list.registrations[0].user_id,undefined,'list must not expose private raw asset path or material');
 assert.equal(list.registrations[0].storage_key,undefined,'never disclose encrypted storage key');
 assert.equal(list.registrations[0].sha256,undefined,'no raw audio fingerprint in public registration response');
 const batch='limit_test_10_batch';
 for(let i=0;i<10;i++){
   const form=makeForm(fileFromText('unique-track-content-'+i,'new'+i+'.mp3'),batch);
   const result=await send(7,form,owner);
   assert.equal(result.status,201,'first 10 batch submissions allowed: '+i+' '+JSON.stringify(result.body));
 }
 const before=stored.size;
 r=await send(7,makeForm(fileFromText('eleventh-track-content','11.mp3'),batch),owner);
 assert.equal(r.status,409,'eleventh distinct registration in a batch must fail');
 assert.equal(r.body.error,'DISCOVERY_REGISTRATION_FAILED');
 assert.equal(stored.size,before,'failed over-limit encrypted object must be deleted');
 assert.equal(sql.prepare('SELECT COUNT(*) n FROM v5_music_discovery WHERE user_id=7 AND batch_id=?').get(batch).n,10);
 r=await send(7,makeForm(fileFromText('nonmusic','file.txt')),owner);
 assert.equal(r.status,400,'disallowed file type must be rejected before storage');
 assert.equal(stored.size,before);
 assert.equal(sql.prepare("SELECT COUNT(*) n FROM v5_music_discovery WHERE status<>'pending_rights'").get().n,0,
   'same owner + different owner claims remain private and unapproved');
 console.log('PASS creator existing release actual Hono/D1: SHA256 duplicate replay, private AES-GCM, cross-user isolation, no rights autoapproval, ten-per-batch, cleanup on failed insert');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{sql.close();fs.rmSync(temp,{recursive:true,force:true})});
