/** Server-authoritative, stateless station timeline. No browser or perpetual process required. */
export const TILO_ZONES={KR:'Asia/Seoul',JP:'Asia/Tokyo',US:'America/New_York',CN:'Asia/Shanghai',TH:'Asia/Bangkok',VN:'Asia/Ho_Chi_Minh'} as const;
export type TiloCountry=keyof typeof TILO_ZONES;
export type TiloTrack={file_id:number;duration_ms:number;title?:string;artist?:string};
export function currentTiloSlot(tracks:readonly TiloTrack[],epochMs:number,anchorMs:number){
  if(!Number.isFinite(epochMs)||!Number.isFinite(anchorMs)||epochMs<anchorMs)return null;
  const valid=tracks.filter(t=>Number.isSafeInteger(t.file_id)&&t.file_id>0&&Number.isSafeInteger(t.duration_ms)&&t.duration_ms>=1000&&t.duration_ms<=3600000);
  if(!valid.length)return null;
  const cycle=valid.reduce((sum,t)=>sum+t.duration_ms,0);
  let offset=(epochMs-anchorMs)%cycle;
  for(const t of valid){
    if(offset<t.duration_ms){
      const startMs=epochMs-offset;
      return {fileId:t.file_id,title:t.title||'',artist:t.artist||'',positionMs:offset,durationMs:t.duration_ms,startAt:new Date(startMs).toISOString(),endsAt:new Date(startMs+t.duration_ms).toISOString(),cycleMs:cycle};
    }
    offset-=t.duration_ms;
  }
  return null;
}
export function tiloLocalShow(country:TiloCountry,now:Date){
  const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:TILO_ZONES[country],hour:'2-digit',hourCycle:'h23'}).format(now));
  return hour>=6&&hour<10?'morning':hour>=10&&hour<18?'day':hour>=18&&hour<22?'evening':'night';
}
