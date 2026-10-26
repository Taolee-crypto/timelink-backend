const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {buildSync}=require('esbuild');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'v5-policy-tables-'));
try{
 buildSync({stdin:{contents:"export * from './src/v5-contribution-policy';export * from './src/v5-daily-free-policy';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',outfile:path.join(temp,'api.cjs'),logLevel:'silent'});
 const api=require(path.join(temp,'api.cjs')),policy=api.DEFAULT_CONTRIBUTION_POLICY;
 const names={purchase:'유료 구매',content:'콘텐츠 이용',listen:'본인 청취',creation:'창작·등록',score:'악보',community:'커뮤니티·기타'};
 const units={KRW:'원',KRW_MARGIN:'확정 이익 원',SECOND:'초',COUNT:'건'};
 const table=(headers,rows)=>'| '+headers.join(' | ')+' |\n| '+headers.map(()=> '---').join(' | ')+' |\n'+rows.map(r=>'| '+r.join(' | ')+' |').join('\n');
 const sections=[];
 const sec=(title,body)=>sections.push('## '+title+'\n\n'+body);
 sec('1. 적용 범위와 최신 결정',`2026-10-26 대화 기준의 상품·경제정책 및 코드 연결 관리표다. 브랜드 TILO, 회사 주식회사 틸로, 한국 자회사 (주)틸로코리아, 암호화폐 TILO의 단위는 TLC다.

모든 상품은 개별 채굴한다. 공동 채굴안은 폐기한다. 구독은 매일 포함시간을 제공하며, 월 총시간을 몰아 쓰는 상품이 아니다. 포함시간을 초과하면 1초당 1TL로 지갑에서 차감한다.

가격·활동별 점수·PoC 가중치·초기 채굴지수는 관리자 검증·조정 가능한 초기 설계값이다. 현재 브랜치에서 구독 판매와 신규 TLC 발행은 활성화하지 않았다.`);
 sec('2. TL-1~TL-24 상품 기준표',table(['상품','하루 포함시간','월 요금 초안','초과 과금','채굴 방식','초기 채굴지수'],api.dailyFreeCatalogue().map(p=>[p.code,p.level+'시간',p.monthlyPriceKrw.toLocaleString('en-US')+'원','1초=1TL','개별',p.miningIndexTlcPerHour.toFixed(3)]))+`\n\n포함시간은 실제 재생만 차감하고 일시정지는 제외한다. 다음 날 포함시간을 다시 제공한다. 부가세, 시간대, 이월, 동시 이용, 환불·구독 변경, 다점포 조건은 출시 설정에서 확정한다. 초과 재생 전 차감 조건을 안내한다.`);
 sec('3. 현금 재원과 비환금성 보상의 구분',table(['원천','곡 사용 시 창작자 70%','플랫폼 30%','원장 처리'],[
 ['현금으로 구매·충전한 유료 TL','유료 재원 창작 정산금','유료 재원 플랫폼 몫','wallet_paid → track_pool:paid → 창작자 wallet_paid'],
 ['플랫폼이 지급한 광고·보너스 TL','비환금성 TL_B','비현금 재원 내부 몫','wallet_ad/bonus → track_pool:ad/bonus → 창작자 wallet_bonus'],
 ['두 재원을 섞어 사용','사용한 재원별로 각각 계산','재원별 구분','합계 표시와 별도로 출처 보존'],
 ['현금 구독료','음악 이용대금의 70% 원칙','30% 원칙','곡별 배분·기준금액·미청취·환불 처리 확정 후 연결']
 ])+`\n\n현금 1만원 충전 시 유료 TL 10,000과 보너스 TL_B 500은 분리한다. 모두 사용하면 창작자 몫은 유료 재원 7,000TL 상당의 정산금과 비환금성 350TL_B다. 지급단가·현금 지급 절차는 별도 정산 정책에 따른다. 보너스를 현금매출이나 현금 지급재원으로 계산하지 않는다.

곡 충전은 내부 이동이므로 구매점수를 다시 주지 않는다. 현재 미재생 잔액의 조기 종료 반환은 기존 정책상 TL_B 반환이다. 유료 원천 보존 원칙과 조기 종료 반환 정책의 관계는 별도 전환 항목으로 남기며 과거 잔액을 임의 재분류하지 않는다.`);
 sec('4. 현금 충전 상품',table(['결제액','유료 TL','보너스 TL_B','총 지급'],[[5000,5000,0,5000],[10000,10000,500,10500],[30000,30000,2000,32000],[50000,50000,5000,55000],[100000,100000,15000,115000]].map(r=>r.map((v,i)=>v.toLocaleString('en-US')+(i===0?'원':'')))));
 sec('5. PoC 영역별 배점',table(['평가 영역','초기 가중치','기준 원점수 상한'],api.CONTRIBUTION_CATEGORIES.map(c=>[names[c],policy.weightsBps[c]/100+'%',policy.categoryTargets[c]+'점']))+`\n\n평가 기간은 최근 30일 이동 기간이다. 각 활동의 점수와 한도를 먼저 적용한 뒤 영역별 기준점수로 정규화하고 가중치를 적용한다. 여섯 가중치 합계는 100%로 검증한다. 따라서 가중치를 바꿔도 활동 종류를 다시 만들 필요가 없다.

영역 점수 = min(영역 활동점수 합계 ÷ 영역 기준점수, 1) × 영역 가중치 × 100. 총점은 영역 점수 합계다.`);
 sec('6. 24개 활동 상세 기준표',table(['활동 코드','평가 영역','활동명','인정 단위','단위당 점수','활동 상한','그룹 상한','점수 설정 상태','검증 근거'],api.contributionTable().map(r=>[r.activity,names[r.category],r.label,r.unitQuantity+' '+units[r.unit],r.pointsPerUnit+'점',r.periodCap+'점',r.group?policy.groupCaps[r.group]+'점('+r.group+')':'—',r.enabled?'초기 설정':'미활성·추후 설정',r.evidence]))+`\n\n추천 그룹의 모든 점수는 합계 8점으로 제한한다. 그룹 상한 초과 시 각 활동 기여를 비례 축소해 입력 순서에 따른 차이를 없앤다. 유료 구매 세부 항목도 합쳐 구매 영역 40점을 넘지 못한다.

결제와 활동에는 고유 증빙키를 사용한다. 동일 결제는 충전·구독·서비스 명목으로 중복 인정할 수 없다. 추천 회원 첫 결제와 스토어 첫 결제도 같은 전환이면 한 번만 인정한다. 본인 추천·본인 콘텐츠 반복 사용·동일 이벤트 재전송은 제외 또는 오류 처리한다. 횟수 활동은 검증된 사건 1개씩 기록하고 임의 합산 횟수는 받지 않는다.

등록된 활동과 실제 점수 수집 연결은 다르다. 현재 신규 저장소에는 실운영으로 확인된 유료 TL 충전만 자동 기록한다. 나머지 검증 생산자 연결은 후속 전환 항목이다. 시험결제·결제환경 불명·기존 자료의 추정값은 신규 구매 기여로 자동 인정하지 않는다.`);
 sec('7. 기여등급 1~9',table(['등급','총점 구간','내부 기여지수'],[
 ['미등급','초기 유효 기여 기준 10점 미만','0'],['1등급','10~20점 미만','0.10~0.20 미만'],['2등급','20~30점 미만','0.20~0.30 미만'],['3등급','30~40점 미만','0.30~0.40 미만'],['4등급','40~50점 미만','0.40~0.50 미만'],['5등급','50~60점 미만','0.50~0.60 미만'],['6등급','60~70점 미만','0.60~0.70 미만'],['7등급','70~80점 미만','0.70~0.80 미만'],['8등급','80~90점 미만','0.80~0.90 미만'],['9등급','90~100점','0.90']
 ])+`\n\n최고값은 0.9이며 내부에서는 연속값을 사용한다. 최소 인정점수 10점은 악용 방지를 위한 초기 제안값으로 관리자 조정 가능하다. 구매만으로 최대 종합지수 0.4이며 다른 활동과 합산해 높은 기여등급에 도달한다.`);
 sec('8. 개별 채굴과 공급 조절',`개인 TLC 산정량 = 실제 유효 청취시간(시간) × 채굴 적용 기여지수 × 상품 채굴지수 × 공통 조정계수.

종합 PoC에는 청취가 포함되지만, 채굴 적용 지수에서는 청취 점수를 제외하고 나머지 영역을 재정규화한다. 초기 가중치 기준으로 채굴 평가점수 = 비청취 영역 점수 합계 ÷ 90 × 100이다. 재정규화 후에는 구매의 상대 비중이 약 44.44%가 되며, 구매만으로 종합지수 0.4·채굴 적용지수 약 0.444444다. 두 지수를 화면과 원장에 명확히 구분한다.

채굴량 증가·TLC 가치 상승 시 공통 조정계수를 낮춘다. 초기에는 관리자 수동 승인으로 적용한다. 개인·전체 한도, 시장가격 근거, 초과 유료 청취의 채굴 인정, 환불·위반에 대한 미지급량 조정은 별도 확정 후 발행 경로에 연결한다. TLC의 현금가치나 고정 수익을 보장하지 않는다.

초기 상품별 지수는 TLC/청취시간/기여지수 단위다. 기존 TL_P 소비량 기반 0.08과 단위가 다르므로 지급 규모가 같다고 해석하지 않는다. 기존 채굴 경로를 그대로 두고 신규 발행까지 동시에 켜지 않는다.`);
 sec('8-1. 상품·기여등급별 월 TLC 계산 예시',table(['상품','1등급 0.1','2등급 0.2','3등급 0.3','4등급 0.4','5등급 0.5','6등급 0.6','7등급 0.7','8등급 0.8','9등급 0.9'],api.dailyFreeCatalogue().map(p=>[p.code,...Array.from({length:9},(_,j)=>{
   const n=BigInt(p.level*30*Math.round(p.miningIndexTlcPerHour*1000)*(j+1));
   const cents=(n+50n)/100n;return String(cents/100n)+'.'+String(cents%100n).padStart(2,'0');
 })]))+'\n\n30일 동안 매일 포함시간을 모두 유효 청취하고, 채굴 적용 기여지수를 각 열의 값으로 고정하며, 공통 조정계수 1.0·추가 지급 한도 미적용을 가정했다. 실제 종합등급과 채굴 적용등급은 청취 중복 제외 때문에 다를 수 있다. 단위는 TLC이며 고정 지급량 또는 현금가치가 아니다.');
 sec('9. 취소·위반·제외 처리표',table(['사건','처리 원칙','이번 코드 연결'],[
 ['동일 이벤트·동일 경제 증빙 중복','실패 처리·중복 점수 금지','평가기·결제 거래키 검증'],['시험결제·불명 결제환경','신규 구매점수 제외','연결 완료'],['미검증·철회 이벤트','점수 제외','평가기 지원'],['기간 밖·미래 활동','점수 제외','평가기 지원'],['본인 대상 추천·콘텐츠 소비','제외','평가기 지원'],['결제 취소·환불','관련 증빙 철회·미지급 보상 재산정','철회 상태 지원·환불 생산자 후속 연결'],['권리 사칭·조작·허위 신고','확정된 판정만 마이너스 기여·3아웃 연결','기존 위반 정책 유지·새 점수 단위 환산 후속'],['단순 의심·심사 중·이의 진행','확정 처벌과 구분·지급 보류 정책 적용','기존 검토 흐름 유지'],['이미 지급된 보상','원장 사실 삭제 없이 별도 정정 거래','과거 자료 자동 변경 없음']
 ]));
 sec('10. 관리자와 API',table(['경로','기능'],[
 ['GET /api/admin/contribution-policy','관리자 정책·24개 활동·24개 상품 조회'],['POST /api/admin/contribution-policy','가중치·점수·한도 수동 변경. 예상 버전과 변경 사유 필수'],['GET /api/admin/contribution-policy/history','초기 버전 포함 전체 정책 스냅샷 이력'],['GET /api/admin/contribution-members/:id','관리자 회원별 신규 기여 평가'],['GET /api/eco/contribution','로그인한 본인의 신규 기여 평가'],['GET /api/eco/daily-free-products','구매 비활성 상태의 상품 설계 조회']
 ])+`\n\n신규 저장소는 v5_contribution_policy, v5_contribution_policy_history, v5_contribution_events다. 외부에서 활동점수를 직접 제출하는 HTTP 경로는 없다. 검증된 서버 생산자만 실제 거래와 같은 원자적 묶음으로 사건을 기록한다. 현재 관리자 API는 기존 관리자 인증·접근 감사 기록을 사용한다. 화면 편집 UI는 후속 연결 항목이다.`);
 sec('11. 경제 리뉴얼 전환 관리표',table(['모듈','이번 반영','남은 연결'],[
 ['상품','24개 등급·모두 개별 채굴·시간 초과 계산','구독 주문·결제·자격·일일 시간 차감 원장·프론트'],['TL 재원','유료·보상분 유지, 보상 소비의 창작자 몫을 TL_B로 수정','기존 환불/조기 종료·현금정산 표시 대조'],['창작 수익','TL_B 수익 집계 및 유료 재원/비현금 재원 구분','현금 지급 실행·권리 미확인 보류분 검증'],['PoC','24개 활동·관리자 변경·버전·평가기·조회 API','사회활동·창작·청취·추천·취소 생산자 연결'],['실결제','실운영 확인 TL충전의 구매 사건 기록·원자적 처리','과거 결제 검증 이관·타 상품 실제 결제 근거'],['TLC','상품 지수·조정 계산 기반','기존 경로 전환·중복 차단·한도·지급 원장·활성 승인'],['스토어·DJ·매니저','활동 코드 확보·기본 점수 미활성','음악 70%와 영업/방송 보수의 재원 충돌 해소'],['TLMALL','마진 기준 구매 기여 코드 확보','확정 마진 증빙 연결·활성화'],['운영','격리된 SQLite·HTTP·회귀 검증','병합·배포 후 실제 계정/결제/청취 E2E 검증']
 ])+`\n\n이번 변경은 리뉴얼의 첫 코드 묶음이다. 운영 DB의 잔액·과거 정산·구독 계약을 임의로 바꾸지 않으며 신규 구독 판매와 TLC 발행을 활성화하지 않는다. 실제 배포 전후 단계별 검증 결과를 개발 관리대장에 남긴다.`);
 const md='# TimeLink V5 상품·PoC·경제시스템 리뉴얼 기준표\n\n2026-10-26 · 초기 설계값 및 코드 연결 현황\n\n'+sections.join('\n\n');
 fs.mkdirSync('docs',{recursive:true});fs.writeFileSync('docs/V5_ECONOMY_RENEWAL_TABLES_20261026.md',md+'\n');
 const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
 const inline=s=>esc(s).replace(/`([^`]+)`/g,'<code>$1</code>');
 const lines=md.split('\n');let parts=[];
 for(let i=0;i<lines.length;i++){
  const line=lines[i];if(!line)continue;
  if(line.startsWith('|')){
   const tableLines=[];while(i<lines.length&&lines[i].startsWith('|'))tableLines.push(lines[i++]);i--;
   const cells=l=>l.split('|').slice(1,-1).map(x=>x.trim());
   parts.push('<div class="scroll"><table><thead><tr>'+cells(tableLines[0]).map(c=>'<th>'+inline(c)+'</th>').join('')+'</tr></thead><tbody>'+tableLines.slice(2).map(l=>'<tr>'+cells(l).map(c=>'<td>'+inline(c)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>');
  }else if(line.startsWith('## '))parts.push('<h2>'+inline(line.slice(3))+'</h2>');
  else if(line.startsWith('# '))parts.push('<h1>'+inline(line.slice(2))+'</h1>');
  else parts.push('<p>'+inline(line)+'</p>');
 }
 const html='<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TimeLink V5 경제 리뉴얼 기준표</title><style>body{margin:0;background:#eef2f7;color:#243348;font:16px/1.8 "Malgun Gothic",sans-serif}main{max-width:1200px;margin:30px auto;padding:42px;background:white;border-radius:12px}h1{font-size:30px;color:#174d88}h2{margin-top:42px;color:#174d88;font-size:23px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.6;margin:20px 0}th{background:#173c67;color:white;text-align:left;padding:12px;white-space:nowrap}td{padding:10px 12px;border-bottom:1px solid #dce4ee;vertical-align:top}tr:nth-child(even){background:#f3f7fc}code{font-size:12px}p{margin:16px 0}@media(max-width:700px){main{padding:20px;margin:0}h1{font-size:25px}}@media print{main{margin:0;padding:0}.scroll{overflow:visible}body{background:white}h2{break-after:avoid}tr{break-inside:avoid}thead{display:table-header-group}table{font-size:8pt}th{background:#dfe9f5;color:#173c67}@page{size:A4 landscape;margin:14mm}}</style><main>'+parts.join('\n')+'</main></html>';
 fs.writeFileSync('docs/TimeLink_V5_Product_Economy_Policy_20261026.html',html);
 console.log('Generated Korean policy tables: 24 products, 24 activities, 6 areas, 9 grades and rollout status.');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
