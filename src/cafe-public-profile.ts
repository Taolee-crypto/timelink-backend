/**
 * Public presentation only. One profile per independently owned cafe channel.
 * No franchise hierarchy, billing, employee or permission changes.
 */
export const CAFE_AMENITIES=['wifi','parking','pets','takeout','terrace','outlets','accessible','delivery'] as const;
export const CAFE_THEMES=['sand','forest','plum','ocean'] as const;
const DAYS=['mon','tue','wed','thu','fri','sat','sun'] as const;
function field(value:unknown,max:number,label:string):string {
 if(value==null)return '';
 if(typeof value!=='string'||value.length>max)throw new Error(label+' 길이·형식 오류');
 return value.trim();
}
export function validateCafeProfile(value:unknown){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('매장 꾸미기 정보 형식 오류');
 const x=value as Record<string,any>;
 const tagline=field(x.tagline,120,'매장 소개 문구');
 const phone=field(x.phone,32,'매장 공개 전화번호');
 if(phone&&!/^[+\d\s().-]+$/.test(phone))throw new Error('공개 전화번호 형식을 확인해 주세요.');
 const website=field(x.website,300,'매장 홈페이지');
 if(website){let url:URL;try{url=new URL(website);}catch{throw new Error('매장 홈페이지 주소 확인 필요');}
  if(url.protocol!=='https:'||!url.hostname.includes('.')||url.username||url.password)throw new Error('매장 홈페이지는 안전한 https 주소만 사용할 수 있습니다.');
 }
 const theme=x.theme==null?'sand':field(x.theme,24,'테마');
 if(!(CAFE_THEMES as readonly string[]).includes(theme))throw new Error('지원하지 않는 카페 테마입니다.');
 const rawAmenities=x.amenities??[];
 if(!Array.isArray(rawAmenities)||rawAmenities.length>CAFE_AMENITIES.length||rawAmenities.some(v=>!(CAFE_AMENITIES as readonly string[]).includes(v))||new Set(rawAmenities).size!==rawAmenities.length)throw new Error('편의시설 선택을 확인해 주세요.');
 const rawMenu=x.menu??[];
 if(!Array.isArray(rawMenu)||rawMenu.length>8)throw new Error('대표 메뉴는 최대 8개입니다.');
 const menu=rawMenu.map((item:any)=>{if(!item||typeof item!=='object'||Array.isArray(item))throw new Error('대표 메뉴 형식 오류');
  const name=field(item.name,60,'대표 메뉴 이름'),detail=field(item.detail,160,'대표 메뉴 소개'),price=field(item.price,32,'대표 메뉴 가격 표시');
  if(!name)throw new Error('대표 메뉴 이름을 입력해 주세요.');return {name,detail,price};
 });
 const rawHours=x.hours??{};
 if(!rawHours||typeof rawHours!=='object'||Array.isArray(rawHours)||Object.keys(rawHours).some(d=>!(DAYS as readonly string[]).includes(d)))throw new Error('영업시간 요일 형식 오류');
 const clock=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
 const hours:Record<string,{closed:boolean,open:string,close:string}>={};
 for(const day of DAYS){const h=rawHours[day];if(!h)continue;
  if(typeof h!=='object'||Array.isArray(h)||typeof h.closed!=='boolean')throw new Error('영업시간 설정 오류');
  const open=field(h.open,5,'시작 시간'),close=field(h.close,5,'종료 시간');
  if(!h.closed&&(!clock.test(open)||!clock.test(close)||open===close))throw new Error('영업시간은 HH:MM 형식이며 시작·종료가 달라야 합니다.');
  hours[day]={closed:h.closed,open:h.closed?'':open,close:h.closed?'':close};
 }
 return {tagline,phone,website,theme,amenities:rawAmenities,hours,menu};
}
export async function ensureCafePublicProfiles(db:any){
 await db.prepare("CREATE TABLE IF NOT EXISTS cafe_public_profiles(channel_id TEXT PRIMARY KEY,profile_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER NOT NULL DEFAULT 0)").run();
}
