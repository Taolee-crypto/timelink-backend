/** V5 renewal: explicit activity registry; contribution scoring never issues TLC. */
export const CONTRIBUTION_CATEGORIES = ['purchase','content','listen','creation','score','community'] as const;
export type ContributionCategory = typeof CONTRIBUTION_CATEGORIES[number];
export const ACTIVITY_DEFINITIONS = {
  paid_subscription:{category:'purchase',label:'음악 구독 실결제',unit:'KRW',evidence:'검증 결제·취소/환불 제외'},
  paid_topup:{category:'purchase',label:'유료 TL 충전',unit:'KRW',evidence:'실결제액만·보너스 제외·사용 시 중복 금지'},
  paid_service:{category:'purchase',label:'광고·홍보 실결제',unit:'KRW',evidence:'검증된 본인 결제'},
  mall_margin:{category:'purchase',label:'TLMALL 구매 기여',unit:'KRW_MARGIN',evidence:'확정된 플랫폼 귀속 이익만'},
  content_listen:{category:'content',label:'제공 콘텐츠의 타인 이용',unit:'SECOND',evidence:'타인 유효 재생·본인/중복 제외'},
  listen:{category:'listen',label:'본인 유효 청취',unit:'SECOND',evidence:'서버 검증 재생 구간'},
  approved_work:{category:'creation',label:'승인 작품 등록',unit:'COUNT',evidence:'권리 확인된 고유 작품 승인'},
  score_register:{category:'score',label:'승인 악보 등록',unit:'COUNT',evidence:'고유 악보 승인'},
  score_share:{category:'score',label:'악보 공유 유입',unit:'COUNT',evidence:'공유 후 고유 타인 방문'},
  score_use:{category:'score',label:'악보 유효 사용',unit:'COUNT',evidence:'동일 회원·악보 반복 제외'},
  like:{category:'community',label:'유효 좋아요',unit:'COUNT',evidence:'회원·대상 고유키·취소 반영'},
  comment:{category:'community',label:'유효 댓글',unit:'COUNT',evidence:'도배/복사 제외·검증된 댓글'},
  share_listen:{category:'community',label:'공유 후 유효 청취',unit:'COUNT',evidence:'고유 타인 실제 청취'},
  referral_verified:{category:'community',label:'추천 본인 확인',unit:'COUNT',evidence:'직접 추천·추천인 본인 제외'},
  referral_listen:{category:'community',label:'추천인 첫 1시간 청취',unit:'COUNT',evidence:'피추천인 최초 달성 1회'},
  referral_paid:{category:'community',label:'추천인 첫 유료 결제',unit:'COUNT',evidence:'최초 결제·환불 반영'},
  referral_store:{category:'community',label:'스토어 추천 성과',unit:'COUNT',evidence:'실매장 확인·첫 결제·회원 첫결제와 중복 제외'},
  referral_creator:{category:'community',label:'창작자 추천 성과',unit:'COUNT',evidence:'추천 창작자의 첫 고유 작품 승인'},
  accepted_report:{category:'community',label:'채택 제보·정보 수정',unit:'COUNT',evidence:'검토자 채택·동일 사안 중복 제외'},
  store_operation:{category:'community',label:'스토어 운영 기여',unit:'COUNT',evidence:'검증 운영 성과·가중치 추후 설정'},
  dj_broadcast:{category:'content',label:'DJ 방송 기여',unit:'SECOND',evidence:'검증 편성·실제 방송·가중치 추후 설정'},
  manager_sale:{category:'community',label:'매니저 영업 기여',unit:'COUNT',evidence:'계약·유효 결제·추천 성과 중복 제외'},
  ad_participation:{category:'community',label:'광고 참여 기여',unit:'COUNT',evidence:'검증 완료 광고·가중치 추후 설정'},
  other_verified:{category:'community',label:'기타 승인 기여',unit:'COUNT',evidence:'구체 활동 코드·승인 증빙 필수'},
} as const;
export type ContributionActivity = keyof typeof ACTIVITY_DEFINITIONS;
export interface ActivityRule { enabled:boolean; unitQuantity:number; pointsPerUnit:number; periodCap:number; group:string|null; }
export interface ContributionPolicy {
  windowDays:number; minimumScore:number; minimumIndex:number; maximumIndex:number;
  weightsBps:Record<ContributionCategory,number>;
  categoryTargets:Record<ContributionCategory,number>;
  groupCaps:Record<string,number>;
  activities:Record<ContributionActivity,ActivityRule>;
}
const rule=(unitQuantity:number,pointsPerUnit:number,periodCap:number,group:string|null=null,enabled=true):ActivityRule=>({enabled,unitQuantity,pointsPerUnit,periodCap,group});
export const DEFAULT_CONTRIBUTION_POLICY:ContributionPolicy = {
  windowDays:30,minimumScore:10,minimumIndex:.1,maximumIndex:.9,
  weightsBps:{purchase:4000,content:2000,listen:1000,creation:1000,score:500,community:1500},
  categoryTargets:{purchase:40,content:20,listen:10,creation:10,score:5,community:15},
  groupCaps:{referral:8,report:3},
  activities:{
    paid_subscription:rule(1000,.8,40),paid_topup:rule(1000,.8,40),paid_service:rule(1000,.8,40),
    mall_margin:rule(1000,.8,40,null,false),content_listen:rule(3600,1,20),listen:rule(3600,.25,10),
    approved_work:rule(1,2,10),score_register:rule(1,.5,2),score_share:rule(1,.05,1),score_use:rule(1,.1,2),
    like:rule(1,.01,.5),comment:rule(1,.05,1.5),share_listen:rule(1,.1,2),
    referral_verified:rule(1,.2,8,'referral'),referral_listen:rule(1,.3,8,'referral'),
    referral_paid:rule(1,1,8,'referral'),referral_store:rule(1,2,8,'referral'),referral_creator:rule(1,1,8,'referral'),
    accepted_report:rule(1,.5,3,'report'),store_operation:rule(1,0,0,null,false),
    dj_broadcast:rule(3600,0,0,null,false),manager_sale:rule(1,0,0,null,false),
    ad_participation:rule(1,0,0,null,false),other_verified:rule(1,0,0,null,false),
  }
};
function numberIn(value:unknown,min:number,max:number):asserts value is number {
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw Error('INVALID_CONTRIBUTION_NUMBER');
}
function exactKeys(value:unknown,keys:readonly string[]):asserts value is Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))throw Error('INVALID_CONTRIBUTION_KEYS');
}
export function validateContributionPolicy(input:unknown):ContributionPolicy {
  exactKeys(input,['windowDays','minimumScore','minimumIndex','maximumIndex','weightsBps','categoryTargets','groupCaps','activities']);
  const p=input as unknown as ContributionPolicy;
  numberIn(p.windowDays,1,366);if(!Number.isInteger(p.windowDays))throw Error('INVALID_WINDOW');
  numberIn(p.minimumScore,.01,100);numberIn(p.minimumIndex,.001,.9);numberIn(p.maximumIndex,p.minimumIndex,.9);
  exactKeys(p.weightsBps,CONTRIBUTION_CATEGORIES);exactKeys(p.categoryTargets,CONTRIBUTION_CATEGORIES);
  let total=0;
  for(const c of CONTRIBUTION_CATEGORIES){numberIn(p.weightsBps[c],0,10000);if(!Number.isInteger(p.weightsBps[c]))throw Error('INVALID_WEIGHT_BPS');total+=p.weightsBps[c];numberIn(p.categoryTargets[c],.001,1000000);}
  if(total!==10000||p.weightsBps.listen===10000)throw Error('CONTRIBUTION_WEIGHTS_MUST_SUM_10000');
  exactKeys(p.groupCaps,['referral','report']);for(const v of Object.values(p.groupCaps))numberIn(v,0,1000000);
  exactKeys(p.activities,Object.keys(ACTIVITY_DEFINITIONS));
  for(const [name,r] of Object.entries(p.activities)){
    exactKeys(r,['enabled','unitQuantity','pointsPerUnit','periodCap','group']);
    if(typeof r.enabled!=='boolean')throw Error('INVALID_ACTIVITY_ENABLED');
    numberIn(r.unitQuantity,1,1000000000);if(!Number.isInteger(r.unitQuantity))throw Error('INVALID_ACTIVITY_UNIT');
    numberIn(r.pointsPerUnit,0,1000000);numberIn(r.periodCap,0,1000000);
    if(r.group!==null&&(typeof r.group!=='string'||!Object.hasOwn(p.groupCaps,r.group)))throw Error('INVALID_ACTIVITY_GROUP');
    if(r.group!==null&&ACTIVITY_DEFINITIONS[name as ContributionActivity].category!=='community')throw Error('GROUP_CATEGORY_MISMATCH');
  }
  return p;
}
export interface ContributionEvent {
  eventKey:string; userId:string; activity:ContributionActivity; quantity:number;
  occurredAtMs:number; evidenceRef:string; economicKey:string;
  counterpartyId:string|null; verified:boolean; revoked:boolean;
}
export function validateContributionEvent(e:ContributionEvent):void {
  if(!e||!Object.hasOwn(ACTIVITY_DEFINITIONS,e.activity)||
    typeof e.eventKey!=='string'||!e.eventKey||e.eventKey.length>200||typeof e.userId!=='string'||!Number.isSafeInteger(Number(e.userId))||!/^[1-9]\d*$/.test(e.userId)||
    typeof e.evidenceRef!=='string'||!e.evidenceRef||e.evidenceRef.length>500||typeof e.economicKey!=='string'||!e.economicKey||e.economicKey.length>200||
    typeof e.verified!=='boolean'||typeof e.revoked!=='boolean')throw Error('INVALID_CONTRIBUTION_EVENT');
  numberIn(e.quantity,0,Number.MAX_SAFE_INTEGER);numberIn(e.occurredAtMs,0,8640000000000000);
  if(!Number.isSafeInteger(e.quantity)||!Number.isSafeInteger(e.occurredAtMs))throw Error('INVALID_EVENT_INTEGER');
  if(e.counterpartyId!==null&&(typeof e.counterpartyId!=='string'||!/^[1-9]\d*$/.test(e.counterpartyId)||!Number.isSafeInteger(Number(e.counterpartyId))))throw Error('INVALID_COUNTERPARTY');
}
function rounded(n:number){return Math.round(n*1000000)/1000000;}
function indexFor(score:number,p:ContributionPolicy){return score<p.minimumScore?0:rounded(Math.min(p.maximumIndex,Math.max(p.minimumIndex,score/100)));}
export function evaluateContributions(events:ContributionEvent[],userId:string,nowMs:number,policy:ContributionPolicy=DEFAULT_CONTRIBUTION_POLICY){
  const p=validateContributionPolicy(policy);numberIn(nowMs,0,8640000000000000);
  const start=nowMs-p.windowDays*86400000;
  const quantities=Object.fromEntries(Object.keys(ACTIVITY_DEFINITIONS).map(a=>[a,0])) as Record<ContributionActivity,number>;
  const keys=new Set<string>(),businessKeys=new Set<string>();let accepted=0,rejected=0;
  for(const e of events){
    validateContributionEvent(e);
    if(e.userId!==userId)throw Error('CONTRIBUTION_USER_MISMATCH');
    // Conflicting duplicates must fail closed; never select the first verification result.
    if(keys.has(e.eventKey))throw Error('DUPLICATE_CONTRIBUTION_EVENT');keys.add(e.eventKey);
    if(!e.verified||e.revoked||e.quantity===0||e.occurredAtMs<=start||e.occurredAtMs>nowMs||!p.activities[e.activity].enabled){rejected++;continue;}
    const needsOther=['content_listen','score_share','score_use','share_listen','referral_verified','referral_listen','referral_paid','referral_store','referral_creator'].includes(e.activity);
    if((needsOther&&!e.counterpartyId)||e.counterpartyId===userId){rejected++;continue;}
    if(ACTIVITY_DEFINITIONS[e.activity].unit==='COUNT'&&e.quantity!==1)throw Error('COUNT_EVENT_MUST_BE_ONE');
    // Receipt IDs must be shared across purchase categories. Referral paid/store
    // share a milestone key so a store conversion cannot be claimed twice.
    const family=ACTIVITY_DEFINITIONS[e.activity].category==='purchase'?'purchase':
      ['referral_paid','referral_store'].includes(e.activity)?'referral_conversion':e.activity;
    const businessKey=family+':'+e.economicKey;
    if(businessKeys.has(businessKey))throw Error('DUPLICATE_CONTRIBUTION_EVIDENCE');businessKeys.add(businessKey);
    quantities[e.activity]+=e.quantity;if(!Number.isSafeInteger(quantities[e.activity]))throw Error('CONTRIBUTION_QUANTITY_OVERFLOW');accepted++;
  }
  const activities={} as Record<ContributionActivity,number>;
  const grouped=new Map<string,number>();
  for(const a of Object.keys(ACTIVITY_DEFINITIONS) as ContributionActivity[]){
    const r=p.activities[a];
    const raw=quantities[a]/r.unitQuantity*r.pointsPerUnit;
    if(!Number.isFinite(raw))throw Error('CONTRIBUTION_SCORE_OVERFLOW');
    activities[a]=Math.min(r.periodCap,raw);
    if(r.group)grouped.set(r.group,(grouped.get(r.group)||0)+activities[a]);
  }
  const rawCategories=Object.fromEntries(CONTRIBUTION_CATEGORIES.map(c=>[c,0])) as Record<ContributionCategory,number>;
  for(const a of Object.keys(ACTIVITY_DEFINITIONS) as ContributionActivity[]){
    const group=p.activities[a].group;
    // Proportional group cap: order-independent contribution from all milestones.
    const groupTotal=group?grouped.get(group)||0:0;
    const factor=group&&groupTotal>p.groupCaps[group]?p.groupCaps[group]/groupTotal:1;
    activities[a]*=factor;rawCategories[ACTIVITY_DEFINITIONS[a].category]+=activities[a];
  }
  const categoryScores={} as Record<ContributionCategory,number>;let score=0,miningNumerator=0;
  for(const c of CONTRIBUTION_CATEGORIES){
    categoryScores[c]=Math.min(1,rawCategories[c]/p.categoryTargets[c])*p.weightsBps[c]/100;
    score+=categoryScores[c];if(c!=='listen')miningNumerator+=categoryScores[c];
  }
  score=rounded(score);
  const miningScore=rounded(miningNumerator/(1-p.weightsBps.listen/10000));
  const index=indexFor(score,p),miningIndex=indexFor(miningScore,p);
  return {windowStartMs:start,windowEndMs:nowMs,score,index,grade:index===0?0:Math.min(9,Math.floor((index+1e-9)*10)),
    miningScore,miningIndex,miningGrade:miningIndex===0?0:Math.min(9,Math.floor((miningIndex+1e-9)*10)),
    categoryScores:Object.fromEntries(CONTRIBUTION_CATEGORIES.map(c=>[c,rounded(categoryScores[c])])),
    activityScores:Object.fromEntries(Object.entries(activities).map(([k,v])=>[k,rounded(v)])),accepted,rejected};
}
export function contributionTable(policy:ContributionPolicy=DEFAULT_CONTRIBUTION_POLICY){
  const p=validateContributionPolicy(policy);
  return Object.entries(ACTIVITY_DEFINITIONS).map(([activity,d])=>({activity,...d,...p.activities[activity as ContributionActivity],categoryWeightBps:p.weightsBps[d.category],categoryTarget:p.categoryTargets[d.category]}));
}
