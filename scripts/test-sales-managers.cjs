const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),{stripTypeScriptTypes}=require('node:module');
function makeFixture(){
 const raw=new DatabaseSync(':memory:');raw.exec('PRAGMA foreign_keys=ON');
 raw.exec(fs.readFileSync('migrations/0003_v3_economy_ledger.sql','utf8'));
 raw.exec(fs.readFileSync('migrations/20261026_sales_managers.sql','utf8'));
 raw.exec(`UPDATE v3_economy_assets SET decimals=4 WHERE asset_code='TL';
 CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT DEFAULT 'user',email_verified INTEGER DEFAULT 1,is_active INTEGER DEFAULT 1,account_forfeited INTEGER DEFAULT 0,tl_p REAL DEFAULT 999999,email TEXT DEFAULT 'fixture@example.test',username TEXT DEFAULT 'Fixture',tl REAL DEFAULT 0,tl_balance REAL DEFAULT 0);
 INSERT INTO users(id)VALUES(1),(2),(3),(4),(5),(6);INSERT INTO users(id,role)VALUES(99,'admin');
 CREATE TABLE cafe_channels(channel_id TEXT PRIMARY KEY,name TEXT,owner_id INTEGER,country TEXT,addr TEXT,description TEXT,images TEXT,playlist TEXT,status TEXT,expires_at TEXT,created_at INTEGER,updated_at INTEGER);
 INSERT INTO cafe_channels VALUES('store1','샘플 매장',1,'KR','','','[]','[]','active','0',0,0);
 CREATE TABLE dj_profiles(id INTEGER PRIMARY KEY,user_id INTEGER,dj_name TEXT,status TEXT);
 INSERT INTO dj_profiles VALUES(30,3,'DJ One','active'),(40,4,'DJ Two','active');
 CREATE TABLE dj_cafe_links(id INTEGER PRIMARY KEY,dj_id INTEGER,cafe_channel_id TEXT,status TEXT,created_at INTEGER,updated_at INTEGER,started_at INTEGER,ended_at INTEGER);
 `);
 function prepare(sql){let args=[];return{bind(...a){args=a;return this},async first(){return raw.prepare(sql).get(...args)||null},async all(){return{results:raw.prepare(sql).all(...args)}},async run(){return raw.prepare(sql).run(...args)},exec(){return /^\s*(SELECT|PRAGMA|WITH)/i.test(sql)?{results:raw.prepare(sql).all(...args)}:{results:[],meta:raw.prepare(sql).run(...args)}}};}
 const db={prepare,async batch(stmts){raw.exec('BEGIN');try{const out=stmts.map(s=>s.exec());raw.exec('COMMIT');return out}catch(e){raw.exec('ROLLBACK');throw e}}};
 const context={crypto:globalThis.crypto,TextEncoder,Date,CREATOR_SHARE_RATE:.7};vm.createContext(context);
 const source=['src/economy-ledger.ts','src/sales-managers.ts'].map(path=>fs.readFileSync(path,'utf8').replace(/^import .*;\n/gm,'')).join('\n');
 vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'}).replace(/export /g,''),context);
 return{raw,db,core:context};
}
async function seedMember(f,uid,country='KR'){
 const p=await f.core.salesPolicy(f.db);
 await f.core.signSalesContract(f.db,uid,{expected_version:p.version,terms_version:'sales-20261026-v2',display_name:'Manager '+uid,country,signature:[[1,1],[20,15],[40,22],[90,60],[180,90]],accept:true});
 await f.core.simulateSalesDeposit(f.db,uid);await f.core.reviewSalesMember(f.db,{user_id:uid,state:'active',reason:'테스트 입금 확인'},99);
}
async function makeHttp(f){
 const bundle=require('esbuild').buildSync({stdin:{contents:"export {default as router} from './src/routes/sales-managers';export {default as cafeRouter} from './src/routes/cafe';export {createToken} from './src/auth';export {Hono} from 'hono';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false}).outputFiles[0].text;
 const m={exports:{}};new Function('module','exports','require',bundle)(m,m.exports,require);
 const app=new m.exports.Hono().route('/api/sales',m.exports.router).route('/api/cafe',m.exports.cafeRouter),secret='fixture-secret-sales-no-production';
 return async(uid,path,body)=>{
  const token=uid?await m.exports.createToken({sub:String(uid),exp:Math.floor(Date.now()/1000)+3600},secret):'';
  const response=await app.fetch(new Request('https://fixture.test'+(path.startsWith('/api/')?path:'/api/sales'+path),{method:body?'POST':'GET',headers:{...(uid?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),{DB:f.db,JWT_SECRET:secret});
  return{status:response.status,data:await response.json()};
 };
}
async function run(){
 const f=makeFixture(),{core:c,db,raw}=f;
 await assert.rejects(c.signSalesContract(db,2,{accept:true}),/가입비/);
 await c.updateSalesPolicy(db,{expected_version:0,join_fee_krw:100000,monthly_fee_tl:50000,manager_bps:2500,dj_bps:2500,reason:'정책 확인'},99);
 await seedMember(f,2);await seedMember(f,4);await seedMember(f,6,'JP');
 assert.equal(raw.prepare('SELECT COUNT(*) n FROM v5_sales_payments').get().n,0);
 assert.throws(()=>raw.prepare("UPDATE v5_sales_members SET fee_krw=0 WHERE user_id=2").run(),/IMMUTABLE/);
 const cafe=raw.prepare("SELECT * FROM cafe_channels WHERE channel_id='store1'").get();
 await assert.rejects(c.assignmentPlan(db,cafe,2,{manager_user_id:2,dj_id:30,kind:'cafe',expected_version:0,reason:'시도'}),/상점주/);
 await assert.rejects(c.assignmentPlan(db,cafe,1,{manager_user_id:6,dj_id:30,kind:'cafe',expected_version:0,reason:'시도'}),/국가/);
 let plan=await c.assignmentPlan(db,cafe,1,{manager_user_id:2,dj_id:30,kind:'cafe',expected_version:0,reason:'상점주 선택'});await db.batch(plan.statements);
 const paid=await c.ensureLedgerAccount(db,'user',1,'TL','wallet_paid'),ad=await c.ensureLedgerAccount(db,'user',1,'TL','wallet_ad');
 raw.prepare('UPDATE v3_economy_balances SET available_atoms=? WHERE account_id=?').run(1000000000,paid);raw.prepare('UPDATE v3_economy_balances SET available_atoms=? WHERE account_id=?').run(1000000,ad);
 const charge=(key,atoms,managerId=2,djUserId=3,atomic=[])=>c.settleCafeService(db,{payerId:1,channelId:'store1',amountAtoms:atoms,key,managerId,djUserId,atomic});
 let result=await charge('test:bonus',1000000);assert.equal(result.manager_revenue,0);assert.equal(result.dj_revenue,0);assert.equal(result.platform_revenue,100);assert.equal(result.creator_revenue,0);
 assert.equal((await c.cafeWallet(db,2)).tl_b,0);assert.equal((await c.cafeWallet(db,2)).tl_p,0);
 result=await charge('test:paid',2000000);assert.equal((await c.cafeWallet(db,2)).tl_p,50);assert.equal(result.creator_revenue,0);
 assert.equal((await charge('test:paid',2000000)).replayed,true);
 assert.equal(raw.prepare('SELECT tl_p FROM users WHERE id=1').get().tl_p,999999);
 const before=(await c.cafeWallet(db,1)).total;
 await assert.rejects(charge('test:rollback',10000,2,3,[db.prepare("SELECT json_extract('invalid','$')")]));
 assert.equal((await c.cafeWallet(db,1)).total,before);
 const raced=await Promise.allSettled([charge('test:race1',600000000),charge('test:race2',600000000)]);assert.equal(raced.filter(x=>x.status==='fulfilled').length,1);
 plan=await c.assignmentPlan(db,cafe,1,{manager_user_id:4,dj_id:40,kind:'store',expected_version:1,reason:'상점주 담당 변경 요청'});await db.batch(plan.statements);
 await assert.rejects(c.assignmentPlan(db,cafe,1,{manager_user_id:2,dj_id:30,kind:'store',expected_version:1,reason:'오래된 화면'}),/변경/);
 result=await charge('test:both',1000000,4,4);assert.equal((await c.cafeWallet(db,4)).tl_p,50);
 assert.equal(raw.prepare("SELECT manager_user_id FROM v5_sales_stores WHERE channel_id='store1'").get().manager_user_id,4);
 assert.equal(raw.prepare("SELECT COUNT(*) n FROM v3_economy_transactions WHERE transaction_type LIKE '%creator%'").get().n,0);
 assert.equal(raw.prepare("SELECT SUM(amount_atoms) n FROM v3_economy_entries").get().n,0);
 assert.ok(raw.prepare('SELECT MIN(available_atoms) n FROM v3_economy_balances').get().n>=0);
 await assert.rejects(c.chargeCafeStream(db,{ownerId:1,channelId:'store1',djId:30,seconds:1,rate:.5,requestId:'wrongdj00000000001'}),/선택한 DJ/);
 const live=await c.chargeCafeStream(db,{ownerId:1,channelId:'store1',djId:40,seconds:1,rate:.5,requestId:'live00000000000001'});assert.ok(live.charged<=.5);
 const same=await c.chargeCafeStream(db,{ownerId:1,channelId:'store1',djId:40,seconds:1,rate:.5,requestId:'live00000000000001'});assert.equal(same.replayed,true);
 if(process.env.CI||(()=>{try{return !!require.resolve('esbuild')}catch{return false}})()){
  const http=await makeHttp(f);
  assert.equal((await http(null,'/me')).status,401);assert.equal((await http(2,'/admin')).status,403);assert.equal((await http(99,'/admin')).status,200);
  assert.equal((await http(null,'/world?kind=all')).status,200);
  assert.equal((await http(2,'/stores/store1/assignment',{manager_user_id:2,dj_id:30,kind:'store',expected_version:2,reason:'비소유자 변경'})).status,403);
  assert.equal((await http(99,'/stores/store1/assignment',{manager_user_id:2,dj_id:30,kind:'store',expected_version:2,reason:'관리자 임의 변경'})).status,403);
  const reg={name:'두번째 스토어',country:'KR',biz_reg_num:'1234567890',biz_type:'individual',addr:'서울 테스트 주소',sales_manager_id:4,dj_id:40,store_kind:'store',sales_accept:true,request_id:'registrationfixture0001'};
  const initialWallet=await c.ensureLedgerAccount(db,'user',1,'TL','wallet_paid');raw.prepare('UPDATE v3_economy_balances SET available_atoms=1000000000 WHERE account_id=?').run(initialWallet);
  const created=await http(1,'/api/cafe/channels',reg);assert.equal(created.status,200,JSON.stringify(created.data));assert.equal(created.data.ok,true);
  const duplicate=await http(1,'/api/cafe/channels',reg);assert.equal(duplicate.status,200);assert.equal(duplicate.data.channel_id,created.data.channel_id);
  assert.equal((await http(null,'/world?kind=all')).data.channels.filter(x=>x.channel_id===created.data.channel_id).length,1);
  assert.equal(raw.prepare('SELECT manager_user_id FROM v5_sales_stores WHERE channel_id=?').get(created.data.channel_id).manager_user_id,4);
  const mine=(await http(2,'/me')).data;assert.equal(mine.managed_stores.length,0);assert.equal(mine.member.user_id,2);
  assert.equal((await http(null,'/directory')).data.managers.some(x=>x.signature_json),false);
 }
 console.log('PASS sales: signed immutable contract, simulated deposit not cash, owner-only/country/CAS assignment, 25/25/50 balanced ledger, noncash origin retained, no creator allocation, concurrent debit guard, atomic rollback, role isolation and stream replay');
}
module.exports={makeFixture,seedMember,makeHttp};
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1});
