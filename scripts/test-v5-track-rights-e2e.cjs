'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite'),{buildSync}=require('esbuild'),{createHash}=require('node:crypto');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'v5-track-rights-'));let sql;
function hash(text){return createHash('sha256').update(Buffer.from(text)).digest('hex');}
async function main(){
 try{
  const out=path.join(tmp,'rights.cjs');
  buildSync({stdin:{contents:
    "export {default as discovery} from './src/routes/music-discovery';"+
    "export {makeAccessToken} from './src/auth';",
    resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:out,logLevel:'silent'});
  const api=require(out);sql=new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE users(
    id INTEGER PRIMARY KEY,email TEXT,role TEXT DEFAULT 'user',
    is_active INTEGER DEFAULT 1,account_forfeited INTEGER DEFAULT 0
  );
  INSERT INTO users(id,email,role) VALUES
    (7,'owner@example.test','user'),(8,'claimant@example.test','user'),(9,'admin@example.test','admin');
  CREATE TABLE tl3_v5_releases(
    file_id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,share_id TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'sealed'
  );
  CREATE TABLE tl_creator_spotify_metadata(
    file_id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,spotify_track_id TEXT NOT NULL,
    isrc TEXT,metadata_json TEXT NOT NULL,fetched_at TEXT NOT NULL
  );`);
  const db={
   prepare(query){let args=[];const st={sql:query,bind(...v){args=v;return st},
    async first(){return sql.prepare(query).get(...args)||null},
    async all(){return {results:sql.prepare(query).all(...args)}},
    async run(){const r=sql.prepare(query).run(...args);return {meta:{changes:Number(r.changes)}}}
   };return st;},
   async batch(items){sql.exec('BEGIN IMMEDIATE');try{const out=[];for(const x of items)out.push(await x.run());sql.exec('COMMIT');return out}catch(e){sql.exec('ROLLBACK');throw e}}
  };
  const stored=new Map();
  const env={DB:db,JWT_SECRET:'track-rights-e2e-secret',STORAGE_ENCRYPTION_KEY:'private-review-encryption-secret',
    R2:{async put(key,body){stored.set(key,new Uint8Array(body))},async delete(key){stored.delete(key)}}};
  const token={};
  for(const id of [7,8,9])token[id]=await api.makeAccessToken(id,env.JWT_SECRET);
  const send=async(id,method,url,body)=>{
    const headers={Authorization:'Bearer '+token[id]};let payload=body;
    if(body&&!(body instanceof FormData)){headers['Content-Type']='application/json';payload=JSON.stringify(body)}
    const res=await api.discovery.request(new Request('https://fixture.invalid'+url,{method,headers,body:payload}),{},env);
    return {status:res.status,body:await res.json()};
  };
  const form=(raw,batch,isrc='')=>{
    const fd=new FormData();fd.append('file',new File([Buffer.from(raw)],'song.mp3',{type:'audio/mpeg'}));
    fd.append('batch_id',batch);fd.append('title','권리검증곡');fd.append('artist','아티스트');
    fd.append('metadata',JSON.stringify({source:'creator-existing-recording-review',rights_role:'recording_owner',
      isrc:isrc||null,evidence_url:'https://rights.example/evidence',acknowledgement:'pending_manual_verification'}));return fd;
  };

  // Exact source fingerprint already registered: reject before private storage.
  const registeredRaw='already-registered-audio';
  sql.prepare('INSERT INTO tl3_v5_releases(file_id,user_id,share_id,source_sha256,status) VALUES(100,7,?,?,\'sealed\')')
    .run('share_existing_sha',hash(registeredRaw));
  let r=await send(8,'POST','/',form(registeredRaw,'batch_dup_sha_01'));
  assert.equal(r.status,409,JSON.stringify(r.body));assert.equal(r.body.error,'TRACK_ALREADY_REGISTERED');
  assert.equal(r.body.duplicate_by,'source_sha256');assert.equal(r.body.file_id,100);assert.equal(stored.size,0);

  // Different bytes but same registered ISRC: reject by track identity.
  sql.prepare('INSERT INTO tl3_v5_releases(file_id,user_id,share_id,source_sha256,status) VALUES(101,7,?,?,\'sealed\')')
    .run('share_existing_isrc',hash('historical-other-binary'));
  sql.prepare(`INSERT INTO tl_creator_spotify_metadata(file_id,user_id,spotify_track_id,isrc,metadata_json,fetched_at)
    VALUES(101,7,'spotify-existing','KR-ABC-26-00001','{}','2026-10-31')`).run();
  r=await send(8,'POST','/',form('new-encoding-same-isrc','batch_dup_isrc_1','KRABC2600001'));
  assert.equal(r.status,409,JSON.stringify(r.body));assert.equal(r.body.duplicate_by,'isrc');assert.equal(r.body.file_id,101);
  assert.equal(stored.size,0);

  // Malformed claimed ISRC is rejected, never silently treated as absent.
  r=await send(7,'POST','/',form('bad-isrc-file','batch_bad_isrc_1','NOT-AN-ISRC'));
  assert.equal(r.status,400);assert.equal(r.body.error,'INVALID_ISRC');

  // An unregistered recording remains eligible for private rights review.
  const claimRaw='new-unregistered-recording';
  r=await send(7,'POST','/',form(claimRaw,'batch_rights_a','KRXYZ2600042'));
  assert.equal(r.status,201,JSON.stringify(r.body));assert.equal(r.body.registration.status,'pending_rights');
  const ownerRegistration=r.body.registration.id;
  assert.equal(sql.prepare('SELECT status FROM v5_music_discovery WHERE id=?').get(ownerRegistration).status,'pending_rights');
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM tl3_v5_releases').get().n,2,'private intake must never create a public release');

  // Another account may file a competing private claim; approval must stop for manual resolution.
  r=await send(8,'POST','/',form(claimRaw,'batch_rights_b','KRXYZ2600042'));
  assert.equal(r.status,201,JSON.stringify(r.body));const competingRegistration=r.body.registration.id;
  r=await send(7,'POST','/'+ownerRegistration+'/review',{decision:'approve',reviewer_note:'not admin',evidence_url:'https://rights.example/admin'});
  assert.equal(r.status,403);assert.equal(r.body.error,'ADMIN_REQUIRED');
  r=await send(9,'POST','/'+ownerRegistration+'/review',{decision:'approve',reviewer_note:'권리 증빙 확인',evidence_url:'https://rights.example/admin'});
  assert.equal(r.status,409);assert.equal(r.body.error,'COMPETING_RIGHTS_CLAIM');

  // Administrator may reject the competing claim, then approve the substantiated claim.
  r=await send(9,'POST','/'+competingRegistration+'/review',{decision:'reject',reviewer_note:'권리 증빙 불충분',evidence_url:'https://rights.example/rejected'});
  assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.status,'rejected');
  r=await send(9,'POST','/'+ownerRegistration+'/review',{decision:'approve',reviewer_note:'원본 녹음 권리 증빙 확인',evidence_url:'https://rights.example/approved'});
  assert.equal(r.status,200,JSON.stringify(r.body));assert.equal(r.body.status,'approved');
  assert.equal(r.body.public,false);assert.equal(r.body.playable,false);assert.equal(r.body.settlement_enabled,false);
  assert.equal(sql.prepare('SELECT status FROM v5_music_discovery WHERE id=?').get(ownerRegistration).status,'approved');
  const audit=sql.prepare('SELECT reviewer_id,decision,evidence_url FROM v5_music_discovery_reviews WHERE registration_id=?').get(ownerRegistration);
  assert.equal(audit.reviewer_id,9);assert.equal(audit.decision,'approve');assert.match(audit.evidence_url,/^https:\/\//);
  assert.equal(sql.prepare('SELECT COUNT(*) n FROM tl3_v5_releases').get().n,2,'rights approval alone cannot manufacture/publish');

  // Owner can see own final review state, but never encrypted storage identifiers/fingerprints.
  r=await send(7,'GET','/');
  assert.equal(r.status,200);const mine=r.body.registrations.find(x=>x.id===ownerRegistration);
  assert.equal(mine.status,'approved');assert.equal(mine.storage_key,undefined);assert.equal(mine.sha256,undefined);

  // Admin review queue no longer includes resolved claims.
  r=await send(9,'GET','/review-queue');
  assert.equal(r.status,200);assert.ok(!r.body.registrations.some(x=>x.id===ownerRegistration||x.id===competingRegistration));

  console.log('PASS track rights E2E: registered SHA/ISRC blocked, unregistered claim allowed, competing claims stop approval, admin audit, no auto publish/play/settle');
 }finally{sql?.close();fs.rmSync(tmp,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1});
