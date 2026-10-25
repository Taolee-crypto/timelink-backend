const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{stripTypeScriptTypes}=require('node:module'),{DatabaseSync}=require('node:sqlite');
const raw=new DatabaseSync(':memory:');let writes=0;
raw.exec(`CREATE TABLE tl_payments(id INTEGER PRIMARY KEY,user_id TEXT,method TEXT,pg_id TEXT UNIQUE,amount_krw INTEGER,tl_granted INTEGER,bonus_tl INTEGER,status TEXT,created_at TEXT DEFAULT(datetime('now')));
CREATE TABLE v3_economy_assets(asset_code TEXT,decimals INTEGER);INSERT INTO v3_economy_assets VALUES('TL',4);
CREATE TABLE v3_economy_transactions(id TEXT,idempotency_key TEXT,transaction_type TEXT,source TEXT,status TEXT,metadata_json TEXT);
CREATE TABLE v3_economy_accounts(id TEXT,owner_type TEXT,bucket TEXT);
CREATE TABLE v3_economy_entries(transaction_id TEXT,account_id TEXT,asset_code TEXT,amount_atoms INTEGER);
INSERT INTO v3_economy_accounts VALUES('platform','platform','playback_revenue_paid'),('user','user','wallet_paid');
INSERT INTO v3_economy_transactions VALUES('music','x','track_playback_settlement','tl3_actual_playback','posted','{}'),('bad','bad','track_playback_settlement','tl3_actual_playback','posted','{}');
INSERT INTO v3_economy_entries VALUES('music','platform','TL',300000),('music','user','TL',-300000),('bad','platform','TL',900000);
`);
function receipt(id,method,status,amount,bonus,mode){
raw.prepare('INSERT INTO tl_payments(id,user_id,method,pg_id,amount_krw,tl_granted,bonus_tl,status)VALUES(?,?,?,?,?,?,?,?)').run(id,'33',method,'pay'+id,amount,amount+bonus,bonus,status);
if(mode)raw.prepare('INSERT INTO v3_economy_transactions VALUES(?,?,?,?,?,?)').run('t'+id,'v5-payment:'+method+':pay'+id,'payment_credit','pg:'+method,'posted',JSON.stringify({payment_mode:mode}));
}
receipt(1,'toss','success',100000,15000,'live');receipt(2,'portone','success',100000,0,null);receipt(3,'stripe','success',50000,5000,'live');
receipt(4,'toss','success',900000,0,'test');receipt(5,'virtual','success',1000000,0,null);
receipt(6,'toss','pending',700000,0,'live');receipt(7,'toss','fail',800000,0,'live');receipt(8,'toss','refunded',20000,0,'live');
function prepare(sql){let args=[];return{bind(...a){args=a;return this},async first(){return raw.prepare(sql).get(...args)||null},async all(){return{results:raw.prepare(sql).all(...args)}},async run(){writes++;throw Error('read only')}};}
const db={prepare,async batch(s){return Promise.all(s.map(x=>x.all()))}};
const ctx={};vm.createContext(ctx);
let source=fs.readFileSync('src/economy-ledger.ts','utf8').replace(/^import .*;\n/gm,'')+'\n'+fs.readFileSync('src/admin-finance-report.ts','utf8').replace(/^import .*;\n/gm,'');
vm.runInContext(stripTypeScriptTypes(source,{mode:'transform'}).replace(/export /g,''),ctx);
(async()=>{
const r=await ctx.readAdminFinance(db);
assert.equal(r.revenue.total_krw,250000);assert.equal(r.revenue.total_tl_sold,250000);assert.equal(r.revenue.bonus_tl,20000);
assert.equal(r.revenue.confirmed_live_krw,150000);assert.equal(r.revenue.unclassified_krw,100000);
assert.equal(r.excluded.test.krw,900000);assert.equal(r.excluded.virtual.krw,1000000);
assert.equal(r.revenue.platform_revenue_tl,30);assert.equal(r.refund_status_records,1);
assert.equal(r.revenue.refund_krw,null);assert.equal(r.revenue.net_cash_krw,null);
assert.equal(r.recent_payments.length,3);assert.equal(r.daily_revenue.reduce((n,x)=>n+x.krw,0),250000);assert.equal(writes,0);
raw.exec("UPDATE v3_economy_assets SET decimals=0");await assert.rejects(ctx.readAdminFinance(db),/SCALE_NOT_READY/);
console.log('PASS: receipt cash totals, bonus separation, test/virtual exclusion, pending/failure/refund exclusion, balanced TL revenue, unknown reconciliation, read-only precision guard');
})().catch(e=>{console.error(e);process.exitCode=1});
