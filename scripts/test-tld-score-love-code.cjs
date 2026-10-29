'use strict';
const assert = require('node:assert/strict');
const {webcrypto} = require('node:crypto');
const {buildSync} = require('esbuild');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tld-love-'));
const built = path.join(tmp, 'codec.cjs');
buildSync({entryPoints:['src/tld-score-core.ts'], outfile: built, platform:'node',
  format:'cjs', bundle:true,logLevel:'silent'});
const {sealTldScore,openLicensedTldScore,issueLoveCode,verifyLoveCode}=require(built);
const manifest={
  profile:'TLD-V5',content_type:'score',asset_id:'tld-score-179',
  version:5,source_tl3_file_id:179,source_tl3_sha256:'e'.repeat(64),
  owner_id:33,title:'길 끝에서',rights_confirmed:true,
  score_revision:'review-approved-1',
  page:{paper:'A4',orientation:'portrait'},lyrics_review_required:false,
  notation_codec:'timelink-scoredata-v1'
};
const score={part:'lead_vocal',melody:[{s:0,d:.5,m:62,lyric:'사랑'},{s:.5,d:.5,m:64,lyric:'해'}],
  chords:[{s:0,sym:'G'}],lyrics_status:'aligned_draft',lyrics_words:[{s:0,d:.5,text:'사랑'}]};
const master='non-production-test-fixture-secret-not-cloudflare';
const fixedKey = new Uint8Array(32).fill(17); // fixture only; no production key generation
const nonce = new Uint8Array(12).fill(29); // fixed test vector ONLY, never production
const binding={
  asset_id:manifest.asset_id,container_sha256:'',user_id:33,
  viewer_id:'viewer_abcdefghijklmnop',viewer_key_thumbprint:'f'.repeat(64),
  session_id:'score_session_fixture_01',rights_policy_id:'creator_share_v1',
  nonce:'nonce_fixture_abcdefgh',expires_at:1_800_000_060
};
async function run(){
  const sealed=await sealTldScore(score,manifest,fixedKey,nonce);
  assert.equal(String.fromCharCode(...sealed.container.slice(0,4)),'TLNK');
  assert.equal(sealed.container[4],5);
  assert.equal(Buffer.from(sealed.container).includes(Buffer.from('사랑','utf8')),false);
  const opened=await openLicensedTldScore(sealed.container,sealed.sha256,fixedKey);
  assert.deepEqual(opened.manifest,manifest);
  assert.deepEqual(opened.score,score);
  const swapped=sealed.container.slice();swapped[swapped.length-2]^=1;
  await assert.rejects(()=>openLicensedTldScore(swapped,sealed.sha256,fixedKey),/INTEGRITY/);
  await assert.rejects(()=>openLicensedTldScore(sealed.container,sealed.sha256,new Uint8Array(32).fill(7)));
  const wrongHeader=sealed.container.slice();wrongHeader[4]=3;
  await assert.rejects(()=>openLicensedTldScore(wrongHeader,sealed.sha256,fixedKey),/MAGIC_VERSION/);
  binding.container_sha256=sealed.sha256;
  const code=await issueLoveCode(master,binding,1_800_000_000);
  assert.equal(await verifyLoveCode(master,binding,code,1_800_000_020),true);
  for(const update of [
    {asset_id:'tld-score-178'},{viewer_id:'viewer_zyxwvutsrqponmlk'},
    {user_id:34},{session_id:'another_session_0001'},
    {container_sha256:'0'.repeat(64)},{rights_policy_id:'other_policy_v1'},
    {viewer_key_thumbprint:'d'.repeat(64)},{nonce:'other_nonce_abcdefgh'},
    {expires_at:1_800_000_040}
  ]){
    assert.equal(await verifyLoveCode(master,{...binding,...update},code,1_800_000_020),false);
  }
  assert.equal(await verifyLoveCode(master,binding,code,1_800_000_061),false);
  assert.equal(await verifyLoveCode(master,binding,'invalid-love-code',1_800_000_020),false);
  console.log('PASS TLNK V5 TLD music-score container, protected bytes, LOVE CODE asset/viewer/session bindings and tamper tests');
}
run().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(tmp,{recursive:true,force:true}));
