import {ensureLedgerAccount,postLedgerTransaction,assertTLAtomScale} from './economy-ledger';
import {krWithholding,readKrPolicy} from './kr-finance';
type Row=Record<string,any>;
function text(value:unknown,min=2,max=500):string{if(typeof value!=='string'||value.trim().length<min||value.length>max)throw Error('필수 증빙·입력값 확인 필요');return value.trim();}
function integer(value:unknown,min=0):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>1000000000000)throw Error('정수 금액·번호 확인 필요');return value;}
function businessDate(value:unknown):string{const s=text(value,10,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s||s>new Date(Date.now()+9*3600000).toISOString().slice(0,10))throw Error('유효한 과거·오늘 회계일 필요');return s;}
function check(db:D1Database,sql:string,args:any[]=[]){return db.prepare("SELECT CASE WHEN ("+sql+") THEN 1 ELSE json_extract('invalid','$') END").bind(...args);}
function openPeriod(db:D1Database,date:string){return check(db,'NOT EXISTS(SELECT 1 FROM v5_kr_periods WHERE month=?)',[date.slice(0,7)]);}
function journal(db:D1Database,input:{id:string;key:string;date:string;uid:number;actor:number;description:string;evidence:string;policy:number;lines:Array<[string,number]>}){
 const x=input,lines=x.lines.filter(([,n])=>n!==0);if(lines.reduce((a,[,n])=>a+n,0)!==0||lines.length<2)throw Error('전표 불균형');
 return [openPeriod(db,x.date),db.prepare("INSERT INTO v5_kr_journals(id,source_key,template,business_date,user_id,description,evidence,input_json,fingerprint,policy_version,actor_id)VALUES(?,?,'sales_partner',?,?,?,?,?,?,?,?)").bind(x.id,x.key,x.date,x.uid,x.description,x.evidence,JSON.stringify(x),JSON.stringify(x),x.policy,x.actor),...lines.map(([account,amount])=>db.prepare('INSERT INTO v5_kr_lines(journal_id,account,amount_krw)VALUES(?,?,?)').bind(x.id,account,amount)),db.prepare("UPDATE v5_kr_journals SET status='posted' WHERE id=?").bind(x.id)];
}
export async function readSalesFinance(db:D1Database,month:string){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw Error('조회 월 확인 필요');
 await assertTLAtomScale(db);
 const queries=[
 `SELECT c.channel_id,c.name,c.owner_id,c.country,c.addr,c.status,c.expires_at,COALESCE(s.kind,'cafe') kind,s.manager_user_id,m.display_name manager_name,m.state manager_state,s.dj_id,d.user_id dj_user_id,d.dj_name,d.status dj_state,COALESCE(s.version,0) assignment_version,u.username owner_name FROM cafe_channels c LEFT JOIN users u ON u.id=c.owner_id LEFT JOIN v5_sales_stores s ON s.channel_id=c.channel_id LEFT JOIN v5_sales_members m ON m.user_id=s.manager_user_id LEFT JOIN dj_profiles d ON d.id=s.dj_id ORDER BY c.created_at DESC LIMIT 1000`,
 `SELECT p.*,c.name store_name,m.display_name manager_name,d.dj_name,j.id accounting_journal_id,t.status ledger_status,t.metadata_json FROM v5_sales_payments p LEFT JOIN cafe_channels c ON c.channel_id=p.channel_id LEFT JOIN v5_sales_members m ON m.user_id=p.manager_user_id LEFT JOIN dj_profiles d ON d.user_id=p.dj_user_id LEFT JOIN v3_economy_transactions t ON t.id=p.ledger_transaction_id LEFT JOIN v5_kr_journals j ON j.source_key='sales:service:'||p.id AND j.status='posted' WHERE strftime('%Y-%m',p.created_at,'+9 hours')=? ORDER BY p.created_at DESC,p.id DESC LIMIT 501`,
 `SELECT d.id,d.user_id,d.dj_name,d.status FROM dj_profiles d ORDER BY d.dj_name LIMIT 1000`,
 `SELECT user_id,income_type,vat_type,verified,version,reason FROM v5_kr_tax_profiles ORDER BY user_id LIMIT 1000`,
 `SELECT s.*,COALESCE((SELECT json_group_array(json_object('channel_id',p.channel_id,'country',c.country,'manager_user_id',p.manager_user_id,'dj_user_id',p.dj_user_id,'store_name',c.name)) FROM v5_sales_settlement_items i JOIN v5_sales_payments p ON p.id=i.payment_id LEFT JOIN cafe_channels c ON c.channel_id=p.channel_id WHERE i.settlement_id=s.id),'[]') source_links_json FROM v5_sales_settlements s WHERE substr(s.business_date,1,7)=? ORDER BY s.created_at DESC LIMIT 501`,
 `SELECT i.*,s.state FROM v5_sales_settlement_items i JOIN v5_sales_settlements s ON s.id=i.settlement_id JOIN v5_sales_payments p ON p.id=i.payment_id WHERE s.state<>'cancelled' AND strftime('%Y-%m',p.created_at,'+9 hours')=? LIMIT 25001`,
 `SELECT l.account,COALESCE(SUM(l.amount_krw),0) amount FROM v5_kr_lines l JOIN v5_kr_journals j ON j.id=l.journal_id WHERE j.status='posted' AND substr(j.business_date,1,7)<=? AND l.account IN ('manager_payable','dj_payable','manager_cost','dj_cost') GROUP BY l.account`
 ];
 const r=await db.batch(queries.map((sql,i)=>[1,4,5,6].includes(i)?db.prepare(sql).bind(month):db.prepare(sql)));
 const payments=(r[1].results||[]) as Row[],settlements=(r[4].results||[]) as Row[];
 const totals=await db.prepare(`SELECT COUNT(*) transactions,COALESCE(SUM(amount_atoms),0) service_atoms,COALESCE(SUM(manager_paid_atoms),0) manager_paid_atoms,COALESCE(SUM(dj_paid_atoms),0) dj_paid_atoms,COALESCE(SUM(platform_atoms),0) platform_atoms,COALESCE(SUM(CASE WHEN json_valid(origin_json) THEN COALESCE(json_extract(origin_json,'$.wallet_paid'),0) ELSE 0 END),0) paid_service_atoms FROM v5_sales_payments WHERE strftime('%Y-%m',created_at,'+9 hours')=?`).bind(month).first();
 return{ok:true,month,as_of:new Date().toISOString(),timezone:'Asia/Seoul',stores:r[0].results||[],payments:payments.slice(0,500),djs:r[2].results||[],profiles:r[3].results||[],settlements:settlements.slice(0,500),claimed_items:(r[5].results||[]).slice(0,25000),partner_accounts:r[6].results||[],summary:totals,truncated:{claims:(r[5].results||[]).length>25000,payments:payments.length>500,settlements:settlements.length>500,stores:(r[0].results||[]).length>=1000},note:'TL 서비스 사용·배분 실적입니다. 원화 매출·순이익·은행 입금과 구분합니다. 정산은 이미 지급된 TL_P를 예약하고 증빙 확인 후 처리합니다.'};
}
export async function createSalesSettlement(db:D1Database,b:Row,actor:number){
 const requestKey=text(b.request_key,16,100);if(!/^[a-zA-Z0-9_-]+$/.test(requestKey))throw Error('요청 키 확인 필요');
 const uid=integer(b.user_id,1),role=b.role;if(!['manager','dj'].includes(role))throw Error('역할 확인 필요');
 const date=businessDate(b.business_date),gross=integer(b.gross_krw,1),base=integer(b.tax_base_krw),evidence=text(b.terms_evidence),bank=text(b.bank_reference,4,150);
 if(b.contract_confirmed!==true||b.identity_confirmed!==true||b.tax_timing_confirmed!==true)throw Error('계약·원화 평가·명의·과세 지급시기 확인이 필요합니다.');
 if(!Array.isArray(b.payment_ids)||!b.payment_ids.length||b.payment_ids.length>50||b.payment_ids.some((x:unknown)=>typeof x!=='string'||x.length>100))throw Error('원거래 1~50건 선택 필요');
 const ids=[...new Set(b.payment_ids as string[])].sort();if(ids.length!==b.payment_ids.length)throw Error('중복 원거래');
 const existing=await db.prepare('SELECT * FROM v5_sales_settlements WHERE request_key=?').bind(requestKey).first<Row>();
 if(existing){const oldIds=((await db.prepare('SELECT payment_id FROM v5_sales_settlement_items WHERE settlement_id=? ORDER BY payment_id').bind(existing.id).all<{payment_id:string}>()).results||[]).map(x=>x.payment_id);if(existing.user_id!==uid||existing.role!==role||existing.gross_krw!==gross||existing.tax_base_krw!==base||existing.business_date!==date||existing.terms_evidence!==evidence||existing.bank_reference!==bank||JSON.stringify(ids)!==JSON.stringify(oldIds))throw Error('같은 요청 번호의 내용이 다릅니다.');return{settlement:existing,replayed:true};}
 const profile=await db.prepare('SELECT * FROM v5_kr_tax_profiles WHERE user_id=?').bind(uid).first<Row>();
 if(!profile||!['business_personal','other_service','business_taxable','domestic_corporation'].includes(profile.income_type))throw Error('매니저·DJ 용역 세무 분류를 먼저 확인하세요. 저작자 기타소득·비거주자는 이 지급 경로에서 처리하지 않습니다.');
 const tax=krWithholding({gross_krw:gross,tax_base_krw:base,single_case_confirmed:b.single_case_confirmed},profile);
 const policy=await readKrPolicy(db);if(!policy.opening_confirmed||!policy.framework||policy.framework==='unconfirmed')throw Error('원화 회계 설정·기초 대사 확인 필요');
 const col=role==='manager'?'manager_paid_atoms':'dj_paid_atoms',owner=role==='manager'?'manager_user_id':'dj_user_id';
 const rows:Row[]=[];for(const id of ids){const row=await db.prepare(`SELECT p.*,date(p.created_at,'+9 hours') service_date FROM v5_sales_payments p JOIN v3_economy_transactions t ON t.id=p.ledger_transaction_id WHERE p.id=? AND p.${owner}=? AND t.status='posted' AND NOT EXISTS(SELECT 1 FROM v3_economy_entries e WHERE e.transaction_id=t.id GROUP BY e.asset_code HAVING SUM(e.amount_atoms)<>0)`).bind(id,uid).first<Row>();if(!row||Number(row[col])<=0)throw Error('확정된 유료 재원 배분만 정산할 수 있습니다.');if(date<row.service_date)throw Error('서비스 이용일 이전에 정산을 기표할 수 없습니다.');rows.push(row);}
 const atoms=rows.reduce((n,row)=>n+Number(row[col]),0);integer(atoms,1);
 const id=crypto.randomUUID(),journalId=crypto.randomUUID(),wallet=await ensureLedgerAccount(db,'user',uid,'TL','wallet_paid'),escrow=await ensureLedgerAccount(db,'escrow',id,'TL','sales_settlement');
 const vat=profile.vat_type==='taxable10'?gross-base:0;if(vat<0)throw Error('VAT 확인 필요');
 const guards=[openPeriod(db,date),check(db,'EXISTS(SELECT 1 FROM users WHERE id=? AND COALESCE(is_active,1)=1 AND COALESCE(account_forfeited,0)=0)',[uid]),check(db,'EXISTS(SELECT 1 FROM v5_kr_tax_profiles WHERE user_id=? AND version=?)',[uid,profile.version]),check(db,'EXISTS(SELECT 1 FROM v5_kr_policy WHERE id=1 AND version=?)',[policy.version])];
 for(const row of rows)guards.push(check(db,`NOT EXISTS(SELECT 1 FROM v5_sales_settlement_items i JOIN v5_sales_settlements s ON s.id=i.settlement_id WHERE i.payment_id=? AND i.role=? AND s.state<>'cancelled')`,[row.id,role]));
 const result=await postLedgerTransaction(db,{idempotencyKey:'sales:reserve:'+requestKey,transactionType:'sales_settlement_reserve',source:'sales_admin',referenceType:'sales_settlement',referenceId:id,actorUserId:String(actor),description:'파트너 유료 TL_P 정산 예약',metadata:{settlement_id:id,user_id:uid,role,tl_atoms:atoms,gross_krw:gross},lines:[{accountId:wallet,assetCode:'TL',amountAtoms:-atoms},{accountId:escrow,assetCode:'TL',amountAtoms:atoms}],issuanceStatements:guards,atomicStatements:[
 db.prepare("INSERT INTO v5_sales_settlements(id,request_key,user_id,role,state,tl_atoms,gross_krw,tax_base_krw,vat_krw,national_krw,local_krw,net_krw,business_date,profile_version,profile_json,terms_evidence,bank_reference,accrual_journal_id,created_by)VALUES(?,?,?,?,'reserved',?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,requestKey,uid,role,atoms,gross,base,vat,tax.national_krw,tax.local_krw,tax.net_krw,date,profile.version,JSON.stringify(profile),evidence,bank,journalId,actor),
 ...rows.map(row=>db.prepare('INSERT INTO v5_sales_settlement_items(settlement_id,payment_id,role,amount_atoms)VALUES(?,?,?,?)').bind(id,row.id,role,row[col])),
 ...journal(db,{id:journalId,key:'sales:accrual:'+id,date,uid,actor,description:(role==='manager'?'매니저':'DJ')+' 정산 의무',evidence,policy:policy.version,lines:[[role+'_cost',gross],[role+'_payable',-gross]]}),
 db.prepare('INSERT INTO v5_sales_settlement_events(id,settlement_id,action,actor_id,data_json)VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),id,'reserved',actor,JSON.stringify({tax,vat_krw:vat,bank_reference:bank}))
 ]});
 return{settlement:await db.prepare('SELECT * FROM v5_sales_settlements WHERE id=?').bind(id).first(),transaction_id:result.id,replayed:result.replayed};
}
export async function transitionSalesSettlement(db:D1Database,id:string,action:string,b:Row,actor:number){
 const s=await db.prepare('SELECT * FROM v5_sales_settlements WHERE id=?').bind(id).first<Row>();if(!s)throw Error('정산 없음');
 const expected=integer(b.expected_version),reason=text(b.reason);if(s.version!==expected)throw Error('정산 상태가 변경됐습니다. 다시 조회하세요.');
 const policy=await readKrPolicy(db),guard=check(db,'EXISTS(SELECT 1 FROM v5_sales_settlements WHERE id=? AND version=? AND state=?)',[id,expected,s.state]);
 const event=(data:Row)=>db.prepare('INSERT INTO v5_sales_settlement_events(id,settlement_id,action,actor_id,data_json)VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),id,action,actor,JSON.stringify({reason,...data}));
 if(action==='approve'){
  if(s.state!=='reserved'||b.review_confirmed!==true)throw Error('예약 정산을 검토한 뒤 승인하세요.');
  await db.batch([guard,check(db,'EXISTS(SELECT 1 FROM v5_kr_tax_profiles WHERE user_id=? AND version=? AND verified=1)',[s.user_id,s.profile_version]),db.prepare("UPDATE v5_sales_settlements SET state='approved',approved_by=?,version=version+1,updated_at=datetime('now') WHERE id=?").bind(actor,id),event({})]);
 }else if(action==='cancel'){
  if(!['reserved','approved'].includes(s.state))throw Error('지급 완료 건은 직접 취소할 수 없습니다. 회계 정정을 검토하세요.');
  const date=businessDate(b.business_date);if(date<s.business_date)throw Error('정산 발생일 이전 취소 불가');const wallet=await ensureLedgerAccount(db,'user',s.user_id,'TL','wallet_paid'),escrow=await ensureLedgerAccount(db,'escrow',id,'TL','sales_settlement');
  await postLedgerTransaction(db,{idempotencyKey:'sales:cancel:'+id,transactionType:'sales_settlement_cancel',source:'sales_admin',referenceType:'sales_settlement',referenceId:id,actorUserId:String(actor),description:'파트너 정산 취소·예약 TL 반환',metadata:{settlement_id:id,reason},lines:[{accountId:escrow,assetCode:'TL',amountAtoms:-s.tl_atoms},{accountId:wallet,assetCode:'TL',amountAtoms:s.tl_atoms}],issuanceStatements:[guard],atomicStatements:[...journal(db,{id:crypto.randomUUID(),key:'sales:cancel:'+id,date,uid:s.user_id,actor,description:'파트너 정산 예약 취소',evidence:reason,policy:policy.version,lines:[[s.role+'_cost',-s.gross_krw],[s.role+'_payable',s.gross_krw]]}),db.prepare("UPDATE v5_sales_settlements SET state='cancelled',version=version+1,updated_at=datetime('now') WHERE id=?").bind(id),event({business_date:date})]});
 }else if(action==='record-payment'){
  if(s.state!=='approved'||b.bank_paid_confirmed!==true||b.no_prior_payment_confirmed!==true)throw Error('승인된 정산의 실제 은행 지급 증빙과 중복 미지급 확인 필요');
  const date=businessDate(b.business_date),evidence=text(b.payment_evidence,4,300);if(date<s.business_date)throw Error('발생일 이전 지급 불가');
  const escrow=await ensureLedgerAccount(db,'escrow',id,'TL','sales_settlement'),redeemed=await ensureLedgerAccount(db,'platform','timelink','TL','sales_redeemed'),jid=crypto.randomUUID();
  await postLedgerTransaction(db,{idempotencyKey:'sales:paid:'+id,transactionType:'sales_settlement_paid',source:'sales_admin',referenceType:'sales_settlement',referenceId:id,actorUserId:String(actor),description:'증빙 확인 파트너 지급·예약 TL 정리',metadata:{settlement_id:id,payment_evidence:evidence,net_krw:s.net_krw},lines:[{accountId:escrow,assetCode:'TL',amountAtoms:-s.tl_atoms},{accountId:redeemed,assetCode:'TL',amountAtoms:s.tl_atoms}],issuanceStatements:[guard,check(db,'EXISTS(SELECT 1 FROM v5_kr_tax_profiles WHERE user_id=? AND version=? AND verified=1)',[s.user_id,s.profile_version]),check(db,"COALESCE((SELECT SUM(l.amount_krw) FROM v5_kr_lines l JOIN v5_kr_journals j ON j.id=l.journal_id WHERE j.status='posted' AND l.account='bank'),0)>=?",[s.net_krw])],atomicStatements:[...journal(db,{id:jid,key:'sales:paid:'+id,date,uid:s.user_id,actor,description:'파트너 지급·원천세',evidence,policy:policy.version,lines:[[s.role+'_payable',s.gross_krw],['bank',-s.net_krw],['withholding_national',-s.national_krw],['withholding_local',-s.local_krw]]}),db.prepare("UPDATE v5_sales_settlements SET state='paid',payout_journal_id=?,payment_evidence=?,version=version+1,updated_at=datetime('now') WHERE id=?").bind(jid,evidence,id),event({business_date:date,payment_evidence:evidence})]});
 }else if(action==='tax-evidence'){
  if(s.state!=='paid')throw Error('지급 완료 정산만 신고·납부 증빙을 연결할 수 있습니다.');
  if(!['reported','national_paid','local_paid','income_submitted'].includes(b.kind))throw Error('세금 증빙 종류 확인 필요');
  const evidence=text(b.evidence,4,300),extra:D1PreparedStatement[]=[];let journalId:string|null=null,amount=0;
  if(['national_paid','local_paid'].includes(b.kind)){
   journalId=text(b.tax_journal_id,1,100);const account=b.kind==='national_paid'?'withholding_national':'withholding_local';amount=b.kind==='national_paid'?s.national_krw:s.local_krw;if(amount<=0)throw Error('해당 정산의 납부 대상 세액이 없습니다.');
   extra.push(check(db,`EXISTS(SELECT 1 FROM v5_kr_journals j WHERE j.id=? AND j.status='posted' AND j.template='tax_payment' AND j.business_date>=?) AND COALESCE((SELECT SUM(l.amount_krw) FROM v5_kr_lines l WHERE l.journal_id=? AND l.account=? AND l.amount_krw>0),0)-COALESCE((SELECT SUM(json_extract(data_json,'$.amount_krw')) FROM v5_sales_settlement_events WHERE action='tax-evidence' AND json_extract(data_json,'$.journal_id')=?),0)>=?`,[journalId,s.business_date,journalId,account,journalId,amount]));
  }
  extra.push(check(db,`NOT EXISTS(SELECT 1 FROM v5_sales_settlement_events WHERE settlement_id=? AND action='tax-evidence' AND json_extract(data_json,'$.kind')=?)`,[id,b.kind]));
  await db.batch([guard,...extra,event({kind:b.kind,evidence,journal_id:journalId,amount_krw:amount}),db.prepare("UPDATE v5_sales_settlements SET version=version+1,updated_at=datetime('now') WHERE id=?").bind(id)]);
 }else throw Error('지원하지 않는 처리');
 return{settlement:await db.prepare('SELECT * FROM v5_sales_settlements WHERE id=?').bind(id).first(),external_transfer_executed:false};
}
