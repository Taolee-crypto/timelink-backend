export type KrInput=Record<string,any>;
type KrLine={account:string;amount_krw:number};
export const KR_FINANCE_SOURCES=[
 {name:'국세청 법인세율 2026',url:'https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7746&mi=2372'},
 {name:'2026 법인지방소득세',url:'https://www.anyang.go.kr/main/contents.do?key=482'},
 {name:'국세청 부가가치세',url:'https://b.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7693&mi=2272'},
 {name:'국세청 기타소득 원천징수',url:'https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7893&mi=6457'},
 {name:'국세청 비거주자 원천징수',url:'https://www.nts.go.kr/nts/cm/cntnts/cntntsView.do?cntntsId=7917&mi=6637'}];
function fail(message:string):never{throw Error(message);}
function money(v:unknown,zero=false){if(typeof v!=='number'||!Number.isSafeInteger(v)||v<0||(!zero&&!v)||v>1000000000000)fail('원화 금액은 1조 원 이하의 정수로 입력하세요.');return v;}
function text(v:unknown,min=2,max=500){if(typeof v!=='string'||v.trim().length<min||v.length>max)fail('사유·증빙 등 필수 입력값을 확인하세요.');return v.trim();}
function userId(v:unknown,required=false){if(v==null&&!required)return null;if(!Number.isSafeInteger(v)||Number(v)<=0)fail('유효한 회원 번호가 필요합니다.');return Number(v);}
function date(v:unknown){const s=text(v,10,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)fail('유효한 회계일을 입력하세요.');return s;}
function canonical(value:any):string{if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';return JSON.stringify(value);}
export function krVat(gross:number,mode:string){money(gross);if(!['taxable10','exempt','outside'].includes(mode))fail('부가세 분류를 확인하세요.');const vat=mode==='taxable10'?Math.round(gross/11):0;return{gross_krw:gross,supply_krw:gross-vat,vat_krw:vat,classification:mode,rounding:'증빙 대가 기준 원 단위 반올림·세액 합계 대사 필요'};}
function progressive(base:number,rates:number[]){const limits=[200000000,20000000000,300000000000,Infinity];let remaining=base,lower=0,total=0;for(let i=0;i<limits.length&&remaining>0;i++){const part=Math.min(remaining,limits[i]-lower);total+=part*rates[i]/10000;remaining-=part;lower=limits[i];}return Math.floor(total);}
export function krCorporate(input:KrInput){
 if(input.year!==2026)fail('현재 검증된 세율표는 2026 사업연도입니다.');
 if(input.entity_type!=='ordinary')fail('일반 영리법인 이외 유형은 세무 검토가 필요합니다.');
 const nationalBase=money(input.national_base_krw,true),localBase=money(input.local_base_krw,true);
 const national=progressive(nationalBase,[1000,2000,2200,2500]),local=progressive(localBase,[100,200,220,250]);
 const ncredit=money(input.national_credit_krw??0,true),lcredit=money(input.local_credit_krw??0,true);
 const npaid=money(input.national_prepaid_krw??0,true),lpaid=money(input.local_prepaid_krw??0,true);
 return{kind:'corporate',year:2026,national_base_krw:nationalBase,local_base_krw:localBase,national_calculated_krw:national,local_calculated_krw:local,national_due_krw:Math.max(0,national-ncredit)-npaid,local_due_krw:Math.max(0,local-lcredit)-lpaid,status:'estimate',note:'입력한 연간 과세표준 기준. 국세·지방세 독립 계산. 공제한도·최저한세·특례·세무조정·조례를 검토한 입력이 필요합니다. 신고 확정액이 아닙니다.'};
}
export function krWithholding(input:KrInput,profile:KrInput){
 if(!profile||!profile.verified||profile.income_type==='unclassified'||profile.vat_type==='unknown')fail('수취인의 소득·부가세 분류와 증빙을 먼저 확인하세요.');
 const gross=money(input.gross_krw),base=money(input.tax_base_krw,true);if(base>gross)fail('원천징수 기준액이 총 지급대가보다 큽니다.');
 const expectedBase=profile.vat_type==='taxable10'?gross-Math.round(gross/11):gross;
 if(base!==expectedBase)fail('부가세 구분에 맞는 원천징수 기준액을 입력하세요.');
 const taxFloor=(v:number)=>Math.floor(v/10)*10;
 let n=0,l=0,method='';
 if(profile.income_type==='business_personal'){n=taxFloor(base*3/100);l=taxFloor(n/10);method='사업소득 3% + 지방소득세';}
 else if(profile.income_type==='other_author'){
  const income=base-Math.floor(base*60/100);
  if(input.single_case_confirmed!==true)fail('기타소득은 건별 합산 및 필요경비 60% 적용 여부를 확인하세요.');
  n=income<=50000?0:taxFloor(income*20/100);l=taxFloor(n/10);method='저작자 기타소득: 필요경비 60%·건별 과세최저한';
 }else if(profile.income_type==='domestic_corporation'){method='내국법인 저작권료: 개인 원천세 미적용';}
 else if(profile.income_type==='nonresident'){
  if(!Number.isInteger(profile.national_bps)||!Number.isInteger(profile.local_bps))fail('비거주자 조세조약·국세·지방세 검토 세율이 필요합니다.');
  n=taxFloor(base*profile.national_bps/10000);l=taxFloor(base*profile.local_bps/10000);method='비거주자 검토 세율';
 }else fail('소득 유형 확인 필요');
 if(n+l>gross)fail('원천세가 지급액을 초과합니다.');
 return{kind:'withholding',gross_krw:gross,tax_base_krw:base,national_krw:n,local_krw:l,net_krw:gross-n-l,method,status:'estimate',note:'현금 송금·신고는 실행하지 않습니다. TL 적립·재사용·상계·TLC 전환의 지급시기 판정은 별도 확인이 필요합니다.'};
}
export async function readKrPolicy(db:D1Database){const row=await db.prepare('SELECT * FROM v5_kr_policy WHERE id=1').first<any>();if(!row)fail('원화 회계 저장소 준비 필요');return{version:Number(row.version),...JSON.parse(row.data_json),updated_at:row.updated_at};}
export async function saveKrPolicy(db:D1Database,input:KrInput,actor:number){
 const expected=money(input.expected_version,true),reason=text(input.reason),evidence=text(input.evidence);
 if(!['unconfirmed','general','sme','kifrs'].includes(input.framework)||!['unconfirmed','principal','agent'].includes(input.role))fail('회계기준·본인/대리인 분류 확인 필요');
 const data={entity_name:text(input.entity_name,2,100),framework:input.framework,role:input.role,opening_confirmed:input.opening_confirmed===true,
  creator_rate_bps:input.creator_rate_bps==null?null:money(input.creator_rate_bps,true),creator_rate_evidence:input.creator_rate_bps==null?null:evidence};
 if(data.creator_rate_bps!=null&&data.creator_rate_bps>10000)fail('환전율은 0~10000 bps 범위입니다.');
 await db.batch([
  db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_kr_policy WHERE id=1 AND version=?) THEN 1 ELSE json_extract('invalid','$') END").bind(expected),
  db.prepare('UPDATE v5_kr_policy SET version=version+1,data_json=?,actor_id=?,updated_at=datetime(\'now\') WHERE id=1 AND version=?').bind(JSON.stringify(data),actor,expected),
  db.prepare('INSERT INTO v5_kr_policy_history(version,data_json,actor_id,reason,evidence)VALUES(?,?,?,?,?)').bind(expected+1,JSON.stringify(data),actor,reason,evidence)
 ]);return readKrPolicy(db);
}
export async function saveKrProfile(db:D1Database,input:KrInput,actor:number){
 const uid=userId(input.user_id,true)!,reason=text(input.reason),evidence=text(input.evidence);
 if(!await db.prepare('SELECT id FROM users WHERE id=?').bind(uid).first())fail('회원 없음');
 if(!['unclassified','business_personal','other_author','domestic_corporation','nonresident'].includes(input.income_type)||!['unknown','exempt','taxable10','outside'].includes(input.vat_type))fail('소득·부가세 유형 확인 필요');
 const rates=['national_bps','local_bps'].map(k=>input[k]==null?null:money(input[k],true));
 if(rates.some(v=>v!=null&&v>10000)||(rates[0]||0)+(rates[1]||0)>10000)fail('세율 합계를 확인하세요.');
 if(input.verified===true&&(input.income_type==='unclassified'||input.vat_type==='unknown'||(input.income_type==='nonresident'&&rates.some(v=>v==null))))fail('미확정 분류를 확인 완료로 저장할 수 없습니다.');
 const expected=money(input.expected_version,true),id=crypto.randomUUID();
 const data={user_id:uid,income_type:input.income_type,vat_type:input.vat_type,national_bps:rates[0],local_bps:rates[1],verified:input.verified===true?1:0,version:expected+1,reason,evidence};
 await db.batch([
  db.prepare("SELECT CASE WHEN COALESCE((SELECT version FROM v5_kr_tax_profiles WHERE user_id=?),0)=? THEN 1 ELSE json_extract('invalid','$') END").bind(uid,expected),
  db.prepare('INSERT INTO v5_kr_tax_profiles(user_id,income_type,vat_type,national_bps,local_bps,verified,version,actor_id,reason,evidence)VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET income_type=excluded.income_type,vat_type=excluded.vat_type,national_bps=excluded.national_bps,local_bps=excluded.local_bps,verified=excluded.verified,version=excluded.version,actor_id=excluded.actor_id,reason=excluded.reason,evidence=excluded.evidence,updated_at=datetime(\'now\')').bind(uid,data.income_type,data.vat_type,...rates,data.verified,data.version,actor,reason,evidence),
  db.prepare('INSERT INTO v5_kr_profile_history(id,user_id,data_json,actor_id)VALUES(?,?,?,?)').bind(id,uid,JSON.stringify(data),actor)
 ]);return data;
}
async function accountBalance(db:D1Database,account:string,uid:number|null=null){
 const r=await db.prepare("SELECT COALESCE(SUM(l.amount_krw),0) amount FROM v5_kr_lines l JOIN v5_kr_journals j ON j.id=l.journal_id WHERE j.status='posted' AND l.account=? AND (? IS NULL OR j.user_id=?)").bind(account,uid,uid).first<any>();return Number(r?.amount||0);
}
export async function postKrJournal(db:D1Database,input:KrInput,actor:number){
 const businessDate=date(input.business_date),description=text(input.description),evidence=text(input.evidence),template=text(input.template,2,30);
 const uid=userId(input.user_id),policy=await readKrPolicy(db);let key=text(input.source_key,4,160);
 if(!/^[a-zA-Z0-9:_./-]+$/.test(key))fail('원거래 키는 영문·숫자·:_./-만 사용하세요.');
 const fingerprint=canonical(input);
 const prior=await db.prepare('SELECT id,fingerprint FROM v5_kr_journals WHERE source_key=? AND status=\'posted\'').bind(key).first<any>();
 if(prior){if(prior.fingerprint!==fingerprint)fail('같은 원거래 키로 다른 전표를 만들 수 없습니다.');return{id:prior.id,replayed:true};}
 let lines:KrLine[]=[];const guards:D1PreparedStatement[]=[];
 const add=(account:string,amount_krw:number)=>{if(amount_krw)lines.push({account,amount_krw});};
 const cover=(account:string,amount:number,credit=false,owner:number|null=null)=>{
  guards.push(db.prepare(`SELECT CASE WHEN COALESCE((SELECT SUM(l.amount_krw)*? FROM v5_kr_lines l JOIN v5_kr_journals j ON j.id=l.journal_id WHERE j.status='posted' AND l.account=? AND (? IS NULL OR j.user_id=?)),0)>=? THEN 1 ELSE json_extract('invalid','$') END`).bind(credit?-1:1,account,owner,owner,amount));
 };
 let gross=0;
 if(template==='payment'){
  const p=await db.prepare(`SELECT p.*,CASE WHEN json_valid(t.metadata_json) THEN json_extract(t.metadata_json,'$.payment_mode') ELSE NULL END payment_mode FROM tl_payments p LEFT JOIN v3_economy_transactions t ON t.idempotency_key='v5-payment:'||p.method||':'||p.pg_id WHERE p.id=?`).bind(money(input.payment_id)).first<any>();
  if(!p||p.status!=='success'||!['toss','portone','stripe'].includes(p.method)||p.payment_mode==='test'||input.cash_verified!==true||uid!==Number(p.user_id)||key!=='receipt:'+p.id)fail('실결제 확인·영수증·회원·원거래 키를 확인하세요.');
  gross=money(Number(p.amount_krw));add('pg_receivable',gross);add('prepaid',-gross);
 }else if(template==='deposit'){
  gross=money(input.amount_krw);const fee=money(input.fee_krw??0,true);if(fee>=gross)fail('PG 수수료 확인 필요');cover('pg_receivable',gross);add('bank',gross-fee);add('pg_cost',fee);add('pg_receivable',-gross);
 }else if(template==='service'){
  if(policy.framework==='unconfirmed'||!policy.framework||policy.role!=='principal')fail('회계기준·서비스 본인 분류 확정 후 사용하세요. 대리인 거래는 검토된 별도 전표를 사용하세요.');
  if(!uid)fail('서비스를 이용한 회원 번호 필요');
  gross=money(input.amount_krw);const vat=krVat(gross,input.vat_type);
  if(!['service_revenue','certificate_revenue','promotion_revenue'].includes(input.revenue_account))fail('서비스 수익 계정 확인 필요');
  cover('prepaid',gross,true,uid);add('prepaid',gross);add(input.revenue_account,-vat.supply_krw);add('vat_output',-vat.vat_krw);
 }else if(template==='creator_accrual'){
  if(!uid||input.krw_value_confirmed!==true)fail('권리자 및 계약상 원화 평가 확인 필요');
  gross=money(input.amount_krw);add('rights_cost',gross);add('creator_payable',-gross);
 }else if(template==='payout'){
  if(!uid)fail('권리자 회원 번호 필요');
  const profile=await db.prepare('SELECT * FROM v5_kr_tax_profiles WHERE user_id=?').bind(uid).first<any>();
  gross=money(input.amount_krw);const tax=krWithholding({...input,gross_krw:gross},profile);
  guards.push(db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM v5_kr_tax_profiles WHERE user_id=? AND version=?) THEN 1 ELSE json_extract('invalid','$') END").bind(uid,profile.version));
  cover('creator_payable',gross,true,uid);add('creator_payable',gross);add('bank',-tax.net_krw);add('withholding_national',-tax.national_krw);add('withholding_local',-tax.local_krw);
 }else if(template==='expense'){
  gross=money(input.amount_krw);const vat=krVat(gross,input.vat_type);
  if(input.deductible===true&&vat.vat_krw){add('operating_cost',vat.supply_krw);add('vat_input',vat.vat_krw);}else add('operating_cost',gross);
  add('bank',-gross);
 }else if(template==='corporate_accrual'){
  const tax=krCorporate(input);
  if(key!=='corporate:'+input.year)fail('법인세 원거래 키는 corporate:연도 형식입니다. 변경은 역분개로 처리하세요.');
  if(tax.national_due_krw<0||tax.local_due_krw<0)fail('환급 추정은 검토된 수동 전표로 처리하세요.');
  const np=money(input.national_prepaid_krw??0,true),lp=money(input.local_prepaid_krw??0,true);
  if(np)cover('national_prepaid',np);if(lp)cover('local_prepaid',lp);
  add('tax_expense',tax.national_due_krw+tax.local_due_krw+np+lp);
  add('corporate_national',-tax.national_due_krw);add('corporate_local',-tax.local_due_krw);
  add('national_prepaid',-np);add('local_prepaid',-lp);
 }else if(template==='refund'){
  if(!uid)fail('환급 대상 회원 번호 필요');gross=money(input.amount_krw);cover('prepaid',gross,true,uid);add('prepaid',gross);add('bank',-gross);
 }else if(template==='vat_payment'){
  const output=-(await accountBalance(db,'vat_output')),offset=await accountBalance(db,'vat_input');
  if(output<=offset||offset<0)fail('부가세 환급 또는 과세기간 조정은 검토된 수동 전표로 처리하세요.');
  cover('vat_output',output,true);if(offset)cover('vat_input',offset);
  add('vat_output',output);add('vat_input',-offset);add('bank',-(output-offset));
 }else if(template==='tax_payment'){
  gross=money(input.amount_krw);if(!['withholding_national','withholding_local','corporate_national','corporate_local'].includes(input.tax_account))fail('국세·지방세 계정 확인 필요');
  cover(input.tax_account,gross,true);add(input.tax_account,gross);add('bank',-gross);
 }else if(template==='reversal'){
  const old=await db.prepare("SELECT id,user_id FROM v5_kr_journals WHERE id=? AND status='posted'").bind(text(input.reverses,1,100)).first<any>();
  if(!old||uid!==old.user_id||key!=='reversal:'+old.id)fail('역분개 원전표 확인 필요');
  lines=((await db.prepare('SELECT account,-amount_krw amount_krw FROM v5_kr_lines WHERE journal_id=? ORDER BY id').bind(old.id).all<KrLine>()).results||[]);
  for(const line of lines){if(['prepaid','creator_payable','rights_held','vat_output','withholding_national','withholding_local','corporate_national','corporate_local','other_payable'].includes(line.account)&&line.amount_krw>0)cover(line.account,line.amount_krw,true,['prepaid','creator_payable'].includes(line.account)?uid:null);}
 }else if(template==='manual'){
  if(input.accounting_reviewed!==true||!Array.isArray(input.lines)||input.lines.length<2||input.lines.length>30)fail('회계 검토한 차변·대변 전표가 필요합니다.');
  lines=input.lines.map((l:KrLine)=>{if(!Number.isSafeInteger(l.amount_krw)||!l.amount_krw)fail('원화 정수 확인 필요');money(Math.abs(l.amount_krw));return{account:String(l.account),amount_krw:l.amount_krw};});
 }else fail('지원하지 않는 전표 유형');
 const known=new Set(((await db.prepare('SELECT code FROM v5_kr_accounts').all<{code:string}>()).results||[]).map(a=>a.code));
 if(lines.length<2||lines.some(l=>!known.has(l.account))||lines.reduce((n,l)=>n+l.amount_krw,0)!==0)fail('차변·대변 합계 또는 계정을 확인하세요.');
 const id=crypto.randomUUID();
 try{await db.batch([
  db.prepare("SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM v5_kr_periods WHERE month=?) THEN 1 ELSE json_extract('invalid','$') END").bind(businessDate.slice(0,7)),
  db.prepare("SELECT CASE WHEN (SELECT version FROM v5_kr_policy WHERE id=1)=? THEN 1 ELSE json_extract('invalid','$') END").bind(policy.version),
  ...guards,
  db.prepare('INSERT INTO v5_kr_journals(id,source_key,template,business_date,user_id,description,evidence,input_json,fingerprint,policy_version,actor_id)VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id,key,template,businessDate,uid,description,evidence,canonical(input),fingerprint,policy.version,actor),
  ...lines.map(l=>db.prepare('INSERT INTO v5_kr_lines(journal_id,account,amount_krw)VALUES(?,?,?)').bind(id,l.account,l.amount_krw)),
  db.prepare("UPDATE v5_kr_journals SET status='posted' WHERE id=?").bind(id)
 ]);}catch(error){
  const raced=await db.prepare("SELECT id,fingerprint FROM v5_kr_journals WHERE source_key=? AND status='posted'").bind(key).first<any>();
  if(raced&&raced.fingerprint===fingerprint)return{id:raced.id,replayed:true};
  throw Error('기표 실패: 원거래 중복·잔액·정책 버전·마감 상태를 확인하세요.');
 }
 return{id,replayed:false,lines};
}
export async function closeKrPeriod(db:D1Database,input:KrInput,actor:number){
 const month=text(input.month,7,7);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))fail('마감 월 확인 필요');
 const kst=new Date(Date.now()+9*3600000).toISOString().slice(0,7);if(month>=kst)fail('종료된 과거 월만 마감할 수 있습니다.');
 const reason=text(input.reason);if(input.reconciled!==true)fail('은행·PG·TL·세금 대사 확인 필요');
 const policy=await readKrPolicy(db);if(!policy.opening_confirmed)fail('기초 잔액 확인 후 마감하세요.');
 await db.prepare("INSERT INTO v5_kr_periods(month,status,actor_id,reason)VALUES(?,'closed',?,?)").bind(month,actor,reason).run();
 return{month,status:'closed'};
}
export async function readKrFinance(db:D1Database,month:string){
 if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))fail('조회 월 확인 필요');
 const policy=await readKrPolicy(db);
 const result=await db.batch([
 db.prepare(`SELECT a.code,a.name,a.kind,COALESCE(SUM(CASE WHEN j.status='posted' THEN l.amount_krw ELSE 0 END),0) balance_krw FROM v5_kr_accounts a LEFT JOIN v5_kr_lines l ON l.account=a.code LEFT JOIN v5_kr_journals j ON j.id=l.journal_id GROUP BY a.code ORDER BY a.kind,a.code`),
 db.prepare(`SELECT a.code,a.kind,COALESCE(SUM(l.amount_krw),0) balance_krw FROM v5_kr_lines l JOIN v5_kr_accounts a ON a.code=l.account JOIN v5_kr_journals j ON j.id=l.journal_id WHERE j.status='posted' AND substr(j.business_date,1,7)=? GROUP BY a.code`).bind(month),
 db.prepare("SELECT j.* FROM v5_kr_journals j WHERE j.status='posted' ORDER BY j.business_date DESC,j.created_at DESC LIMIT 100"),
 db.prepare('SELECT * FROM v5_kr_tax_profiles ORDER BY user_id LIMIT 200'),
 db.prepare(`SELECT p.id,p.user_id,p.method,p.amount_krw,p.tl_granted,p.bonus_tl,p.created_at FROM tl_payments p WHERE p.status='success' AND p.method IN('toss','portone','stripe') AND NOT EXISTS(SELECT 1 FROM v5_kr_journals j WHERE j.source_key='receipt:'||p.id AND j.status='posted') ORDER BY p.id DESC LIMIT 100`),
 db.prepare("SELECT COUNT(*) count FROM v5_kr_journals WHERE status='posted'"),
 db.prepare("SELECT month,status,reason,created_at FROM v5_kr_periods ORDER BY month DESC LIMIT 24"),
 db.prepare("SELECT version,actor_id,reason,evidence,created_at FROM v5_kr_policy_history ORDER BY version DESC LIMIT 30")
 ]);
 const accounts=(result[0].results||[]) as any[],monthly=(result[1].results||[]) as any[];
 const balance=(code:string)=>Number(accounts.find(a=>a.code===code)?.balance_krw||0);
 const due=(code:string)=>-balance(code)||0;
 const revenues=-monthly.filter(a=>a.kind==='revenue').reduce((n,a)=>n+Number(a.balance_krw),0),costs=monthly.filter(a=>a.kind==='expense').reduce((n,a)=>n+Number(a.balance_krw),0);
 const vatPosition=due('vat_output')-balance('vat_input');
 const protectedNeeds=['prepaid','creator_payable','rights_held','withholding_national','withholding_local','corporate_national','corporate_local','other_payable'].reduce((n,a)=>n+Math.max(0,due(a)),0)+Math.max(0,vatPosition);
 return{ok:true,ledger_version:'V5',jurisdiction:'KR',currency:'KRW',as_of:new Date().toISOString(),month,policy,accounts,
 summary:{bank_krw:policy.opening_confirmed?balance('bank'):null,restricted_cash_krw:policy.opening_confirmed?balance('restricted_cash'):null,
 pg_receivable_krw:due('pg_receivable')*-1,prepaid_liability_krw:due('prepaid'),creator_payable_krw:due('creator_payable'),rights_held_krw:due('rights_held'),
 booked_revenue_krw:revenues,booked_cost_krw:costs,booked_profit_krw:revenues-costs,vat_position_krw:vatPosition,
 withholding_national_krw:due('withholding_national'),withholding_local_krw:due('withholding_local'),
 corporate_national_krw:due('corporate_national'),corporate_local_krw:due('corporate_local'),
 operating_cash_krw:policy.opening_confirmed?balance('bank')-Math.max(0,protectedNeeds-Math.max(0,balance('restricted_cash'))):null,
 journal_count:Number((result[5].results?.[0] as any)?.count||0)},
 journals:(result[2].results||[]).map((j:any)=>({id:j.id,source_key:j.source_key,template:j.template,business_date:j.business_date,user_id:j.user_id,description:j.description,evidence:j.evidence,policy_version:j.policy_version,actor_id:j.actor_id})),
 tax_profiles:result[3].results||[],unbooked_receipts:result[4].results||[],closed_periods:result[6].results||[],policy_history:result[7].results||[],sources:KR_FINANCE_SOURCES,
 coverage:'기표·대사한 거래만 원화 장부에 포함됩니다. 미기표 결제·TL 사용·권리자 보상·은행 거래는 자동으로 0원 확정되지 않습니다.',
 note:'세액은 검토된 입력과 기표 기준입니다. 환전율 미확정 시 창작 수익 TL을 원화 채무로 자동 환산하지 않습니다. 실제 신고·송금은 실행하지 않습니다.'};
}