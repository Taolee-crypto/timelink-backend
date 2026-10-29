'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildSync}=require('esbuild'),{DatabaseSync}=require('node:sqlite');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'share-delete-owner-'));
try{
 buildSync({stdin:{contents:"export {ownsLinkedReleaseForDeletion} from './src/v5-share-delete-ownership';",
 loader:'ts',resolveDir:process.cwd()},platform:'node',bundle:true,format:'cjs',
 outfile:path.join(root,'ownership.cjs'),logLevel:'silent'});
 const {ownsLinkedReleaseForDeletion:verify}=require(path.join(root,'ownership.cjs'));
 const sqlite=new DatabaseSync(':memory:');
 try{
  sqlite.exec(`CREATE TABLE tl_files(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL,shared INTEGER DEFAULT 1);
    CREATE TABLE tl3_v5_releases(share_id TEXT PRIMARY KEY,file_id INTEGER NOT NULL,status TEXT);
    INSERT INTO tl_files(id,user_id) VALUES (25,2),(35,3);
    INSERT INTO tl3_v5_releases VALUES('other-share',35,'sealed'),('my-share',25,'sealed');`);
  const other=sqlite.prepare("SELECT * FROM tl3_v5_releases WHERE share_id='other-share'").get();
  // Simulate how the endpoint obtains the file with BOTH id and owner condition.
  const restricted=(id,owner)=>sqlite.prepare('SELECT id,user_id FROM tl_files WHERE id=? AND user_id=?').get(id,owner)||null;
  assert.equal(restricted(35,2),null);
  assert.equal(verify(2,other,restricted(35,2)),false,'cannot delete another creator released file');
  assert.equal(verify(2,other,{id:35,user_id:3}),false,'cannot trust a globally fetched foreign file');
  assert.equal(verify(2,other,{id:25,user_id:2}),false,'must match the release-linked file ID');
  assert.equal(verify(2,other,null),false,'cannot trust release without user_id');
  const ours=sqlite.prepare("SELECT * FROM tl3_v5_releases WHERE share_id='my-share'").get();
  assert.equal(verify(2,ours,restricted(25,2)),true);
  assert.equal(verify(1,ours,restricted(25,2)),false);
  assert.equal(verify(2,{file_id:'not-a-valid-file'},restricted(25,2)),false);
  assert.equal(verify(2,null,restricted(25,2)),true);
  const source=fs.readFileSync('src/index.ts','utf8');
  const block=source.slice(source.indexOf("app.delete('/api/shares/:id'"),source.indexOf("app.post('/api/shares/:id/pulse'"));
  assert.ok(block.includes('ownsLinkedReleaseForDeletion(userId, release, file)'));
  assert.ok(block.indexOf('ownsLinkedReleaseForDeletion(userId, release, file)')<
    block.indexOf("'DELETE FROM tl3_segments"),'ownership must be enforced before any destructive SQL');
  console.log('PASS: SharePlace delete foreign V5 release denied, verified own release allowed, fails closed before DELETE');
 }finally{sqlite.close()}
}finally{fs.rmSync(root,{recursive:true,force:true})}
