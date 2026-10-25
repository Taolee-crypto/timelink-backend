import {assertTLAtomScale,ensureLedgerAccount,postLedgerTransaction,tlToAtoms,atomsToTl} from './economy-ledger';
export const SALES_TERMS_VERSION='sales-20261026-v2';
type Input=Record<string,any>;
function bad(s:string):never{throw Error(s);}
function str(v:any,min=1,max=500){if(typeof v!=='string'||v.trim().length<min||v.length>max)bad('필수 입력값을 확인하세요.');return v.trim();}
function num(v:any,min=0,max=1000000000){if(!Number.isSafeInteger(v)||v<min||v>max)bad('금액·번호를 확인하세요.');return Number(v);}
export async function salesPolicy(db:D1Database){const p=await db.prepare('SELECT * FROM v5_sales_policy WHERE id=1').first<any>();if(!p)bad('영업 관리 저장소 준비 필요');return{...p,platform_bps:5000,creator_bps:0,payment_mode:'simulation',territory_exclusive:false};}
export function salesTerms(p:Input){return{version:SALES_TERMS_VERSION,policy_version:p.version,fee_krw:p.join_fee_krw,currency:'KRW',clauses:[
 '영업 매니저는 가입 국가 내에서 독점 구역 없이 매장 유치와 관리 업무를 수행합니다. DJ는 방송을 제작·운영합니다.',
 '가입비는 표시한 영업 참여·초기 지원의 대가입니다. 자발적 중도 탈퇴 시 원칙적으로 환급하지 않되 법령상 반환 사유와 회사의 계약 불이행 등에 대한 권리는 배제하지 않습니다.',
 '가입 권리의 제3자 양도는 당사자가 매수자와 가격을 협의하고 회사의 자격 확인·계약 승계 등록을 거칩니다. 회사는 재매입·양도가격·수익을 보장하지 않습니다.',
 '유료 재원으로 지불한 매장 방송 서비스 TL 비용의 50%는 영업 매니저와 DJ의 배분 재원이고 나머지 50%는 플랫폼 몫입니다. 이 비용에서 창작자 몫을 추가 배분하지 않으며 음원 사용 보상은 별도입니다.',
 '현재 배분은 영업 매니저 '+(p.manager_bps/100)+'%, DJ '+(p.dj_bps/100)+'%입니다. 관리자 변경은 변경 이후 거래에 적용하고 기존 지급 기록은 유지합니다.',
 '상점주는 담당 매니저 변경을 요청할 수 있습니다. 담당 매니저 변경 이후의 거래부터 새 담당자에게 배분합니다.',
 '가입 선물·광고·보너스 TL 사용에는 매니저와 DJ의 새 보수를 배분하지 않습니다. 유료 재원 배분의 현금 정산에는 계약상 자격·원화 평가·신원·세무 확인과 원천징수 등이 적용될 수 있습니다.',
 '현재 입금 안내는 테스트용 가상 입금 참조번호이며 실제 은행 계좌가 아닙니다. 실제 송금하지 마세요. 테스트 입금은 현금 매출로 기록되지 않습니다.',
 '회원 계정의 서명과 동의 시각, 계약 내용 및 서명 해시를 함께 기록하는 전자서명 방식에 동의합니다.'
]};}
export async function updateSalesPolicy(db:D1Database,b:Input,actor:number){
 const v=num(b.expected_version),fee=b.join_fee_krw==null?null:num(b.join_fee_krw),monthly=num(b.monthly_fee_tl,1),m=num(b.manager_bps,0,5000),d=num(b.dj_bps,0,5000),reason=str(b.reason,2);
 if(m+d!==5000)bad('매니저와 DJ 배분 합계는 50%여야 합니다.');
 await db.batch([db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_sales_policy WHERE id=1 AND version=?) THEN 1 ELSE json_extract('invalid','$') END").bind(v),
 db.prepare("UPDATE v5_sales_policy SET version=version+1,join_fee_krw=?,monthly_fee_tl=?,manager_bps=?,dj_bps=?,updated_by=?,reason=?,updated_at=datetime('now') WHERE id=1 AND version=?").bind(fee,monthly,m,d,actor,reason,v),
 db.prepare('INSERT INTO v5_sales_policy_history(version,data_json,actor_id)VALUES(?,?,?)').bind(v+1,JSON.stringify({fee,monthly,m,d,reason}),actor)]);
 return salesPolicy(db);
}
export async function signSalesContract(db:D1Database,uid:number,b:Input,userAgent=''){
 const p=await salesPolicy(db);if(p.join_fee_krw==null)bad('가입비 안내 준비 중입니다. 관리자 설정 후 서명할 수 있습니다.');
 const existing=await db.prepare('SELECT user_id FROM v5_sales_members WHERE user_id=?').bind(uid).first();if(existing)bad('이미 가입 신청이 있습니다.');
 if(b.expected_version!==p.version||b.terms_version!==SALES_TERMS_VERSION||b.accept!==true)bad('최신 계약을 확인하고 동의하세요.');
 const u=await db.prepare('SELECT id,email_verified,is_active,account_forfeited FROM users WHERE id=?').bind(uid).first<any>();
 if(!u||Number(u.email_verified)!==1||u.is_active===0||u.account_forfeited)bad('이메일 인증과 활성 계정이 필요합니다.');
 const name=str(b.display_name,2,80),country=str(b.country,2,2).toUpperCase();if(!/^[A-Z]{2}$/.test(country))bad('국가 코드를 확인하세요.');
 const points=b.signature;if(!Array.isArray(points)||points.length<5||points.length>4000||points.some((x:any)=>!Array.isArray(x)||x.length!==2||x.some((n:any)=>!Number.isFinite(n)||n<0||n>1000)))bad('계약서에 직접 서명하세요.');
 if(new Set(points.map((x:any)=>x.join(','))).size<5)bad('서명 내용을 확인하세요.');
 const breaks=Array.isArray(b.breaks)?b.breaks:[];if(breaks.length>100||breaks.some((x:any)=>!Number.isInteger(x)||x<0||x>=points.length))bad('서명 기록 확인 필요');
 const terms=salesTerms(p),at=new Date().toISOString(),signature=JSON.stringify({name,points,breaks}),snapshot=JSON.stringify(terms);
 const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({uid,country,snapshot,signature,at}))))).map(x=>x.toString(16).padStart(2,'0')).join('');
 const ref='SIM-SALES-'+crypto.randomUUID().replace(/-/g,'').slice(0,16).toUpperCase(),code=crypto.randomUUID().replace(/-/g,'');
 await db.batch([
 db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_sales_policy WHERE id=1 AND version=?) THEN 1 ELSE json_extract('invalid','$') END").bind(p.version),
 db.prepare("INSERT INTO v5_sales_members(user_id,country,display_name,state,fee_krw,policy_version,terms_version,terms_json,signature_json,signature_hash,signed_at,virtual_ref,invite_code,user_agent)VALUES(?,?,?,'pending_deposit',?,?,?,?,?,?,?,?,?,?)").bind(uid,country,name,p.join_fee_krw,p.version,SALES_TERMS_VERSION,snapshot,signature,hash,at,ref,code,String(userAgent).slice(0,300)),
 db.prepare('INSERT INTO v5_sales_member_events(id,user_id,event_type,actor_id,data_json)VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),uid,'signed',uid,JSON.stringify({hash,terms_version:SALES_TERMS_VERSION,fee_krw:p.join_fee_krw,payment_mode:'simulation'}))
 ]);return{virtual_ref:ref,fee_krw:p.join_fee_krw,state:'pending_deposit',signature_hash:hash,payment_mode:'simulation'};
}
export async function simulateSalesDeposit(db:D1Database,uid:number){
 const member=await db.prepare('SELECT state,virtual_ref,fee_krw FROM v5_sales_members WHERE user_id=?').bind(uid).first<any>();if(!member)bad('가입 신청 없음');
 if(member.state==='simulated_paid'||member.state==='active')return{state:member.state,simulated:true,replayed:true};
 if(member.state!=='pending_deposit')bad('신청 상태 확인 필요');
 await db.batch([db.prepare("UPDATE v5_sales_members SET state='simulated_paid' WHERE user_id=? AND state='pending_deposit'").bind(uid),
 db.prepare('INSERT INTO v5_sales_member_events(id,user_id,event_type,actor_id,data_json)VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),uid,'simulated_deposit',uid,JSON.stringify({amount_krw:member.fee_krw,ref:member.virtual_ref,real_cash:false}))]);
 return{state:'simulated_paid',simulated:true};
}
export async function reviewSalesMember(db:D1Database,b:Input,actor:number){
 const uid=num(b.user_id,1),reason=str(b.reason,2);if(!['active','suspended'].includes(b.state))bad('상태 확인 필요');
 const m=await db.prepare('SELECT state FROM v5_sales_members WHERE user_id=?').bind(uid).first<any>();if(!m)bad('가입 신청 없음');
 if(b.state==='active'&&!['simulated_paid','suspended','active'].includes(m.state))bad('서명·테스트 입금 확인이 필요합니다.');
 await db.batch([
 db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_sales_members WHERE user_id=? AND state=?) THEN 1 ELSE json_extract('invalid','$') END").bind(uid,m.state),
 db.prepare("UPDATE v5_sales_members SET state=?,activation_basis='simulation',reviewed_by=?,review_note=? WHERE user_id=?").bind(b.state,actor,reason,uid),
 db.prepare('INSERT INTO v5_sales_member_events(id,user_id,event_type,actor_id,data_json)VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),uid,'admin_review',actor,JSON.stringify({old:m.state,state:b.state,reason,real_cash:false}))
 ]);return{state:b.state,activation_basis:'simulation'};
}
export async function assignmentPlan(db:D1Database,cafe:Input,owner:number,b:Input){
 if(Number(cafe.owner_id)!==owner)bad('상점주만 담당 매니저를 변경할 수 있습니다.');
 const manager=b.invite_code?await db.prepare("SELECT m.* FROM v5_sales_members m JOIN users u ON u.id=m.user_id WHERE m.invite_code=? AND m.state='active' AND COALESCE(u.is_active,1)=1 AND COALESCE(u.account_forfeited,0)=0").bind(str(b.invite_code,16,80)).first<any>():
 await db.prepare("SELECT m.* FROM v5_sales_members m JOIN users u ON u.id=m.user_id WHERE m.user_id=? AND m.state='active' AND COALESCE(u.is_active,1)=1 AND COALESCE(u.account_forfeited,0)=0").bind(num(b.manager_user_id,1)).first<any>();
 if(!manager||manager.country!==cafe.country)bad('매장 국가에서 활동하는 매니저를 선택하세요.');
 const dj=await db.prepare("SELECT d.id,d.user_id FROM dj_profiles d JOIN users u ON u.id=d.user_id WHERE d.id=? AND d.status='active' AND COALESCE(u.is_active,1)=1 AND COALESCE(u.account_forfeited,0)=0").bind(num(b.dj_id,1)).first<any>();if(!dj)bad('활성 DJ를 선택하세요.');
 const old=await db.prepare('SELECT * FROM v5_sales_stores WHERE channel_id=?').bind(cafe.channel_id).first<any>();const version=Number(old?.version||0);
 if(b.expected_version!==version)bad('담당 정보가 변경되었습니다. 다시 조회하세요.');
 if(!['cafe','store'].includes(b.kind))bad('매장 종류 확인 필요');const reason=str(b.reason,2,500),now=Date.now();
 const statements=[
 db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM cafe_channels WHERE channel_id=? AND owner_id=? AND country=?) THEN 1 ELSE json_extract('invalid','$') END").bind(cafe.channel_id,owner,cafe.country),
 db.prepare("SELECT CASE WHEN COALESCE((SELECT version FROM v5_sales_stores WHERE channel_id=?),0)=? THEN 1 ELSE json_extract('invalid','$') END").bind(cafe.channel_id,version),
 db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_sales_members WHERE user_id=? AND state='active' AND country=?) THEN 1 ELSE json_extract('invalid','$') END").bind(manager.user_id,cafe.country),
 db.prepare('INSERT INTO v5_sales_stores(channel_id,manager_user_id,dj_id,kind,version,owner_id,updated_at)VALUES(?,?,?,?,?,?,?) ON CONFLICT(channel_id) DO UPDATE SET manager_user_id=excluded.manager_user_id,dj_id=excluded.dj_id,kind=excluded.kind,version=excluded.version,owner_id=excluded.owner_id,updated_at=excluded.updated_at').bind(cafe.channel_id,manager.user_id,dj.id,b.kind,version+1,owner,now),
 db.prepare("UPDATE dj_cafe_links SET status='ended',ended_at=?,updated_at=? WHERE cafe_channel_id=? AND status='active'").bind(now,now,cafe.channel_id),
 db.prepare("INSERT INTO dj_cafe_links(dj_id,cafe_channel_id,status,created_at,updated_at,started_at)VALUES(?,?,'active',?,?,?)").bind(dj.id,cafe.channel_id,now,now,now),
 db.prepare('INSERT INTO v5_sales_store_events(id,channel_id,old_manager_id,new_manager_id,dj_id,actor_owner_id,version,reason)VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),cafe.channel_id,old?.manager_user_id??null,manager.user_id,dj.id,owner,version+1,reason)
 ];
 return{manager_user_id:Number(manager.user_id),dj_user_id:Number(dj.user_id),dj_id:Number(dj.id),version:version+1,statements};
}
export async function settleCafeService(db:D1Database,input:{payerId:number;channelId:string;amountAtoms:number;key:string;managerId?:number|null;djUserId?:number|null;guards?:D1PreparedStatement[];atomic?:D1PreparedStatement[];metadata?:Input}){
 await assertTLAtomScale(db);const amount=num(input.amountAtoms,1,1000000000000),p=await salesPolicy(db);
 const prior=await db.prepare('SELECT * FROM v5_sales_payments WHERE idempotency_key=?').bind(input.key).first<any>();
 if(prior){if(prior.payer_user_id!==input.payerId||prior.channel_id!==input.channelId||prior.amount_atoms!==amount)bad('재시도 거래가 일치하지 않습니다.');return{replayed:true,transaction_id:prior.ledger_transaction_id,charged:atomsToTl(prior.amount_atoms),manager_revenue:atomsToTl(prior.manager_atoms),dj_revenue:atomsToTl(prior.dj_atoms),platform_revenue:atomsToTl(prior.platform_atoms),creator_revenue:0,wallet:await cafeWallet(db,input.payerId)};}
 const rows=(await db.prepare("SELECT a.id,a.bucket,b.available_atoms,b.version FROM v3_economy_accounts a JOIN v3_economy_balances b ON b.account_id=a.id WHERE a.owner_type='user' AND a.owner_id=? AND a.asset_code='TL' AND a.status='active' AND a.bucket IN('wallet_ad','wallet_bonus','wallet_paid')").bind(String(input.payerId)).all<any>()).results||[];
 const total=rows.reduce((n,r)=>n+Number(r.available_atoms),0);if(total<amount)throw Object.assign(Error('TL 잔액이 부족합니다.'),{status:402,required:atomsToTl(amount),current:atomsToTl(total)});
 const manager=input.managerId?await db.prepare("SELECT m.user_id FROM v5_sales_members m JOIN users u ON u.id=m.user_id WHERE m.user_id=? AND m.state='active' AND COALESCE(u.is_active,1)=1 AND COALESCE(u.account_forfeited,0)=0").bind(input.managerId).first<any>():null;
 const dj=input.djUserId?await db.prepare('SELECT id FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0').bind(input.djUserId).first<any>():null;
 const map=new Map<string,number>();const add=(id:string,n:number)=>{if(n)map.set(id,(map.get(id)||0)+n);};
 const guards=[...(input.guards||[]),db.prepare("SELECT CASE WHEN (SELECT version FROM v5_sales_policy WHERE id=1)=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0) THEN 1 ELSE json_extract('invalid','$') END").bind(p.version,input.payerId)];
 if(manager)guards.push(db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_sales_members m JOIN users u ON u.id=m.user_id WHERE m.user_id=? AND m.state='active' AND COALESCE(u.is_active,1)=1 AND COALESCE(u.account_forfeited,0)=0) THEN 1 ELSE json_extract('invalid','$') END").bind(manager.user_id));
 if(dj)guards.push(db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0) THEN 1 ELSE json_extract('invalid','$') END").bind(dj.id));
 let left=amount,mt=0,dt=0,pt=0,mp=0,dp=0;const origin:Input={};
 for(const bucket of ['wallet_ad','wallet_bonus','wallet_paid']){
  const row=rows.find(r=>r.bucket===bucket);if(!row||left<=0)continue;const take=Math.min(left,Number(row.available_atoms));if(take<=0)continue;left-=take;origin[bucket]=take;
  guards.push(db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM v3_economy_balances WHERE account_id=? AND version=? AND available_atoms>=?) THEN 1 ELSE json_extract('invalid','$') END").bind(row.id,row.version,take));
  add(row.id,-take);
  const pool=bucket==='wallet_paid'?Math.floor(take/2):0,m=Math.floor(pool*p.manager_bps/5000),d=pool-m,platform=take-pool;
  mt+=m;dt+=d;pt+=platform;if(bucket==='wallet_paid'){if(manager)mp+=m;if(dj)dp+=d;}
  const payoutBucket=bucket==='wallet_paid'?'wallet_paid':'wallet_bonus';
  add(await ensureLedgerAccount(db,manager?'user':'escrow',manager?manager.user_id:input.channelId,'TL',manager?payoutBucket:'cafe_manager_pending_'+bucket),m);
  add(await ensureLedgerAccount(db,dj?'user':'escrow',dj?dj.id:input.channelId,'TL',dj?payoutBucket:'cafe_dj_pending_'+bucket),d);
  add(await ensureLedgerAccount(db,'platform','timelink','TL','cafe_service_revenue_'+bucket),platform);
 }
 if(left)bad('TL 차감 재확인 필요');
 const id=crypto.randomUUID();
 const metadata={...input.metadata,channel_id:input.channelId,amount_atoms:amount,manager_user_id:manager?.user_id||null,dj_user_id:dj?.id||null,manager_atoms:mt,dj_atoms:dt,platform_atoms:pt,creator_atoms:0,origin,policy_version:p.version};
 const posted=await postLedgerTransaction(db,{idempotencyKey:input.key,transactionType:'cafe_service_payment',source:'cafe_service',referenceType:'cafe_channel',referenceId:input.channelId,actorUserId:String(input.payerId),description:'매장 방송 서비스 비용 · 매니저/DJ/플랫폼 배분',metadata,lines:[...map].filter(([,n])=>n!==0).map(([accountId,amountAtoms])=>({accountId,assetCode:'TL' as const,amountAtoms})),issuanceStatements:guards,
 atomicStatements:[...(input.atomic||[]),db.prepare('INSERT INTO v5_sales_payments(id,ledger_transaction_id,idempotency_key,channel_id,payer_user_id,manager_user_id,dj_user_id,amount_atoms,manager_atoms,dj_atoms,platform_atoms,manager_paid_atoms,dj_paid_atoms,policy_version,origin_json)VALUES(?,(SELECT id FROM v3_economy_transactions WHERE idempotency_key=?),?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,input.key,input.key,input.channelId,input.payerId,manager?.user_id??null,dj?.id??null,amount,mt,dt,pt,mp,dp,p.version,JSON.stringify(origin))]});
 return{replayed:posted.replayed,transaction_id:posted.id,charged:atomsToTl(amount),manager_revenue:atomsToTl(mt),dj_revenue:atomsToTl(dt),platform_revenue:atomsToTl(pt),creator_revenue:0,wallet:await cafeWallet(db,input.payerId)};
}
export async function cafeWallet(db:D1Database,uid:number){
 const r=(await db.prepare("SELECT a.bucket,b.available_atoms FROM v3_economy_accounts a JOIN v3_economy_balances b ON b.account_id=a.id WHERE a.owner_type='user' AND a.owner_id=? AND a.asset_code='TL' AND a.status='active' AND a.bucket IN('wallet_ad','wallet_bonus','wallet_paid')").bind(String(uid)).all<any>()).results||[];
 const get=(b:string)=>atomsToTl(r.filter(x=>x.bucket===b).reduce((n,x)=>n+Number(x.available_atoms),0));return{tl_a:get('wallet_ad'),tl_b:get('wallet_bonus'),tl_p:get('wallet_paid'),total:get('wallet_ad')+get('wallet_bonus')+get('wallet_paid')};
}
export async function chargeCafeStream(db:D1Database,input:{ownerId:number;channelId:string;djId:number;seconds:number;rate:number;requestId:string}){
 const key='cafe:stream:'+input.channelId+':'+str(input.requestId,16,100);const old=await db.prepare('SELECT * FROM v5_sales_payments WHERE idempotency_key=?').bind(key).first<any>();
 const link=await db.prepare('SELECT s.*,d.user_id dj_user_id FROM v5_sales_stores s LEFT JOIN dj_profiles d ON d.id=s.dj_id WHERE channel_id=?').bind(input.channelId).first<any>();
 if(link&&link.dj_id!==input.djId)bad('상점주가 선택한 DJ 방송을 사용하세요.');
 if(old)return settleCafeService(db,{payerId:input.ownerId,channelId:input.channelId,amountAtoms:old.amount_atoms,key});
 const now=Date.now();await db.prepare('INSERT OR IGNORE INTO v5_sales_meters(channel_id,dj_id,last_ms)VALUES(?,?,?)').bind(input.channelId,input.djId,now-1000).run();
 const meter=await db.prepare('SELECT * FROM v5_sales_meters WHERE channel_id=?').bind(input.channelId).first<any>();
 const seconds=Math.min(60,Math.floor(input.seconds),Math.floor((now-meter.last_ms)/1000));if(seconds<=0)return{charged:0,wallet:await cafeWallet(db,input.ownerId)};
 if(!Number.isFinite(input.rate)||input.rate<=0||input.rate>100)bad('방송 요율 확인 필요');
 const dj=await db.prepare('SELECT user_id FROM dj_profiles WHERE id=?').bind(input.djId).first<any>();if(!dj)bad('DJ 없음');
 const guards=[db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_sales_meters WHERE channel_id=? AND version=?) THEN 1 ELSE json_extract('invalid','$') END").bind(input.channelId,meter.version)];
 if(link)guards.push(db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_sales_stores WHERE channel_id=? AND version=?) THEN 1 ELSE json_extract('invalid','$') END").bind(input.channelId,link.version));
 return settleCafeService(db,{payerId:input.ownerId,channelId:input.channelId,amountAtoms:tlToAtoms(seconds*input.rate),key,managerId:link?.manager_user_id,djUserId:dj.user_id,guards,atomic:[db.prepare('UPDATE v5_sales_meters SET dj_id=?,last_ms=?,version=version+1 WHERE channel_id=? AND version=?').bind(input.djId,meter.last_ms+seconds*1000,input.channelId,meter.version)],metadata:{seconds,dj_id:input.djId,service:'live_broadcast'}});
}
