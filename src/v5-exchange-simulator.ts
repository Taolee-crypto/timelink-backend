export type SimState={walletTL:number;lockedTL:number;walletTLC:bigint;escrowTLC:bigint;status:'open'|'reserved'|'settled'|'cancelled';events:Set<string>};
export function createSim(tl:number,tlc:bigint):SimState{if(!Number.isSafeInteger(tl)||tl<0||tlc<0n)throw Error('INVALID_BALANCE');return{walletTL:tl,lockedTL:0,walletTLC:0n,escrowTLC:tlc,status:'open',events:new Set()};}
export function reserve(s:SimState,amount:number,key:string){if(s.events.has(key))return false;if(s.status!=='open'||!Number.isSafeInteger(amount)||amount<=0||s.walletTL<amount)throw Error('RESERVE_DENIED');s.walletTL-=amount;s.lockedTL+=amount;s.status='reserved';s.events.add(key);return true;}
export function settle(s:SimState,tlc:bigint,key:string){if(s.events.has(key))return false;if(s.status!=='reserved'||tlc<=0n||s.escrowTLC<tlc)throw Error('SETTLE_DENIED');s.escrowTLC-=tlc;s.walletTLC+=tlc;s.lockedTL=0;s.status='settled';s.events.add(key);return true;}
export function cancel(s:SimState,key:string){if(s.events.has(key))return false;if(s.status!=='reserved')throw Error('CANCEL_DENIED');s.walletTL+=s.lockedTL;s.lockedTL=0;s.status='cancelled';s.events.add(key);return true;}
export function runEscrowSimulation(){const results:{name:string;pass:boolean}[]=[];const check=(name:string,fn:()=>boolean)=>{let pass=false;try{pass=fn()}catch{}results.push({name,pass});};const denied=(fn:()=>unknown)=>{try{fn();return false}catch{return true}};
check('정상 예약 및 정산',()=>{const s=createSim(10000,100000000000n);reserve(s,3600,'reserve1');settle(s,3600000000n,'settle1');return s.walletTL===6400&&s.lockedTL===0&&s.walletTLC===3600000000n&&s.status==='settled'});
check('취소 시 전액 반환',()=>{const s=createSim(100,1000000000n);reserve(s,80,'reserve2');cancel(s,'cancel2');return s.walletTL===100&&s.lockedTL===0&&s.status==='cancelled'});
check('잔액 부족 거부',()=>denied(()=>reserve(createSim(10,100n),11,'over')));
check('중복 예약 차단',()=>{const s=createSim(100,100n);reserve(s,10,'same');return !reserve(s,10,'same')&&s.lockedTL===10});
check('중복 지급 차단',()=>{const s=createSim(100,100n);reserve(s,10,'r');settle(s,50n,'p');return !settle(s,50n,'p')&&s.walletTLC===50n});
check('유동성 부족 거부',()=>{const s=createSim(100,5n);reserve(s,10,'r');return denied(()=>settle(s,6n,'p'))&&s.lockedTL===10});
check('정산 후 취소 거부',()=>{const s=createSim(100,50n);reserve(s,10,'r');settle(s,50n,'p');return denied(()=>cancel(s,'c'))});
check('취소 후 정산 거부',()=>{const s=createSim(100,50n);reserve(s,10,'r');cancel(s,'c');return denied(()=>settle(s,50n,'p'))});
check('소수 TL 예약 거부',()=>denied(()=>reserve(createSim(100,50n),1.5,'r')));
check('마이너스 잔액 생성 거부',()=>denied(()=>createSim(-1,0n)));
return{ok:results.every(x=>x.pass),passed:results.filter(x=>x.pass).length,total:results.length,results,mode:'IN_MEMORY_NO_REAL_ASSETS'};}
