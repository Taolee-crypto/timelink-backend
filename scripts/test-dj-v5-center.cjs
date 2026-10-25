const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {stripTypeScriptTypes}=require('node:module'),{DatabaseSync}=require('node:sqlite');
const sqlite=new DatabaseSync(':memory:');
const db={prepare(sql){let args=[];const s={bind(...a){args=a;return s},async first(){return sqlite.prepare(sql).get(...args)||null},async all(){return {results:sqlite.prepare(sql).all(...args)}},async run(){const r=sqlite.prepare(sql).run(...args);return {meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}}};return s;}};
sqlite.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,username TEXT);
INSERT INTO users VALUES(1,'dj@fixture','DJ'),(2,'creator@fixture','Creator');
CREATE TABLE tl3_v5_releases(file_id INTEGER,share_id TEXT,user_id INTEGER,status TEXT,duration_ms INTEGER);
CREATE TABLE tl_files(id INTEGER PRIMARY KEY,title TEXT,artist TEXT,genre TEXT,cover_image TEXT,file_type TEXT,stream_url TEXT,shared INTEGER,revenue_held INTEGER);
CREATE TABLE tl_creator_metadata(file_id INTEGER,user_id INTEGER,rights_declared INTEGER,rights_role TEXT,rights_scope TEXT,declaration_status TEXT);
CREATE TABLE tl_shares(id TEXT,user_id INTEGER,stream_url TEXT);
INSERT INTO tl3_v5_releases VALUES(11,'v5-first',2,'sealed',180000),(12,'v5-second',2,'sealed',200000),(13,'v5-private',2,'sealed',180000),(14,'v5-held',2,'sealed',180000),(15,'v5-no-rights',2,'sealed',180000);
INSERT INTO tl_files VALUES(11,'First','A','jazz','','audio/tl3','stream11',1,0),(12,'Second','B','pop','','audio/tl3','stream12',1,0),(13,'Private','A','pop','','audio/tl3','stream13',0,0),(14,'Held','A','pop','','audio/tl3','stream14',1,1),(15,'No rights','A','pop','','audio/tl3','stream15',1,0);
INSERT INTO tl_creator_metadata VALUES(11,2,1,'owner','master_recording','declared'),(12,2,1,'owner','master_recording','declared'),(13,2,1,'owner','master_recording','declared'),(14,2,1,'owner','master_recording','declared');
INSERT INTO tl_shares VALUES('old-first',2,'stream11');`);
class Hono{constructor(){this.routes=new Map()}get(path,fn){this.routes.set('GET '+path,fn)}post(path,fn){this.routes.set('POST '+path,fn)}}
const context={console,Hono,DB:db,Date,Math,JSON,Set,Map,Number,String,Array,crypto,
 verifyToken:async token=>/^fixture-user-\d+$/.test(token)?{sub:Number(token.split('-').pop())}:null};
vm.createContext(context);
function transform(path){return stripTypeScriptTypes(fs.readFileSync(path,'utf8'),{mode:'transform'}).replace(/^import .*;\n/gm,'').replace(/^export default router;/m,'globalThis.testRouter=router;').replace(/^export /gm,'');}
vm.runInContext(transform('src/dj-v5-library.ts'),context);
vm.runInContext(transform('src/routes/dj-cafe.ts'),context);
async function call(method,path,body,user=1,params={}){
 const c={env:{DB:db,JWT_SECRET:'fixture'},req:{header:()=>user?'Bearer fixture-user-'+user:'',json:async()=>body,param:key=>params[key]},
 json:(data,status=200)=>({status,data})};const fn=context.testRouter.routes.get(method+' '+path);assert.ok(fn,path);return fn(c);
}
async function main(){
 assert.equal((await call('GET','/library',{},0)).status,401);
 let r=await call('GET','/library');assert.equal(r.status,200);assert.equal(r.data.files.length,2);
 assert.ok(r.data.files.every(t=>t.version===5));
 assert.equal((await call('GET','/my-files')).data.files.length,0);
 assert.ok(await context.djTrack(db,'old-first'));assert.equal(await context.djTrack(db,'v5-private'),null);
 await call('POST','/profile',{dj_name:'Fixture DJ'});
 r=await call('POST','/broadcast-set',{name:'My set',tracks:['v5-second','v5-first','v5-second']});
 assert.equal(r.status,200);assert.deepEqual(Array.from(r.data.set.tracks),['v5-second','v5-first']);
 r=await call('POST','/broadcast-set',{name:'Bad set',tracks:['v5-first','v5-private']});assert.equal(r.status,409);
 assert.equal((await call('GET','/broadcast-set')).data.set.name,'My set');
 assert.equal((await call('POST','/broadcast/start')).data.code,'DJ_AGREEMENT_REQUIRED');
 r=await call('POST','/opening-agreement',{terms_version:'dj-opening-v1-20261023',accept_terms:true,accept_revenue_share:true});
 assert.equal(r.status,200);assert.equal(r.data.opening_fee_tl,0);
 r=await call('POST','/broadcast/start');assert.equal(r.status,200);
 r=await call('POST','/broadcast/start');assert.equal(r.data.already_live,true);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM dj_sessions').get().n,1);
 const station=sqlite.prepare('SELECT id FROM dj_profiles WHERE user_id=1').get().id;
 assert.equal(await context.authorizeDjMonitor(db,1,station,12),true);
 assert.equal(await context.authorizeDjMonitor(db,2,station,12),false);
 assert.equal(await context.authorizeDjMonitor(db,1,station,11),false);
 r=await call('GET','/live/:djId{[0-9]+}/now',{},1,{djId:String(station)});assert.equal(r.data.current_track.file_id,12);
 assert.equal((await call('POST','/broadcast-set',{name:'Cannot edit live',tracks:['v5-first']})).status,409);
 r=await call('POST','/broadcast/next');assert.equal(r.data.track_id,'v5-first');
 sqlite.prepare('UPDATE tl_files SET shared=0 WHERE id=12').run();
 r=await call('POST','/broadcast/next');assert.equal(r.data.track_id,'v5-first');
 assert.equal(await context.authorizeDjMonitor(db,1,station,12),false);
 await call('POST','/broadcast/stop');
 assert.equal(await context.authorizeDjMonitor(db,1,station,11),false);
 assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM dj_sessions WHERE ended_at IS NULL').get().n,0);
 r=await call('POST','/broadcast-set',{name:'',tracks:[]});assert.equal(r.status,200);
 assert.equal((await call('GET','/broadcast-set')).data.set,null);
 console.log('PASS actual DJ route handlers with SQLite: public V5 eligibility, own vs public library, ordering/deduplication, rejected private/held/undeclared tracks, free agreement, start idempotence, live edit guard, next/revocation, stop/delete and owner-only monitor authorization');
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>sqlite.close());
