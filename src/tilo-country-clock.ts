import type { Env } from './types';
export const TILO_COUNTRY_ZONES = {
  KR:'Asia/Seoul',JP:'Asia/Tokyo',US:'America/New_York',
  CN:'Asia/Shanghai',TH:'Asia/Bangkok',VN:'Asia/Ho_Chi_Minh'
} as const;
export type TiloCountryCode = keyof typeof TILO_COUNTRY_ZONES;
export function tiloLocalSchedule(country:TiloCountryCode,at:Date) {
  const zone=TILO_COUNTRY_ZONES[country];
  const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(at);
  const value=(type:string)=>parts.find(p=>p.type===type)?.value||'00';
  const hour=Number(value('hour'));
  const show=hour>=6&&hour<10?'morning':hour>=10&&hour<18?'day':hour>=18&&hour<22?'evening':'night';
  return {country,timeZone:zone,localDate:`${value('year')}-${value('month')}-${value('day')}`,localTime:`${value('hour')}:${value('minute')}`,show,djProfile:({morning:'male-young',day:'male-warm',evening:'male-deep',night:'male-classic'} as const)[show]};
}
export async function refreshTiloCountryClocks(db:Env['DB'],now=new Date()) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS tilo_country_clock (
    country TEXT PRIMARY KEY, time_zone TEXT NOT NULL, local_date TEXT NOT NULL,
    local_time TEXT NOT NULL, show_name TEXT NOT NULL, dj_profile TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`).run();
  for(const country of Object.keys(TILO_COUNTRY_ZONES) as TiloCountryCode[]){
    const p=tiloLocalSchedule(country,now);
    await db.prepare(`INSERT INTO tilo_country_clock(country,time_zone,local_date,local_time,show_name,dj_profile,updated_at)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(country) DO UPDATE SET time_zone=excluded.time_zone,local_date=excluded.local_date,
      local_time=excluded.local_time,show_name=excluded.show_name,dj_profile=excluded.dj_profile,updated_at=excluded.updated_at`)
      .bind(country,p.timeZone,p.localDate,p.localTime,p.show,p.djProfile,now.toISOString()).run();
  }
}
