/**
 * TILO V5 radio-DJ learning source registry.
 * A publicly playable stream is NOT a grant to record, transcribe, train on,
 * clone voices from, or commercially reuse its content.
 * This module performs no network access or recording.
 */
export type TiloCountry = 'KR'|'JP'|'US'|'CN'|'TH'|'VN';
export type LearningUse = 'listen'|'record'|'transcribe'|'analyze'|'train'|'voice_clone';
export interface TiloRadioSource {
  id: string;
  country: TiloCountry;
  name: string;
  officialUrl: string;
  status: 'candidate'|'licensed'|'suspended';
  authorizedUses: LearningUse[];
  licenseReference?: string;
  expiresAt?: string;
}
export const TILO_RADIO_SOURCES: readonly TiloRadioSource[] = [
  {id:'kr-sbs-powerfm',country:'KR',name:'SBS PowerFM',officialUrl:'https://web.gorealra.sbs.co.kr/',status:'candidate',authorizedUses:[]},
  {id:'kr-mbc-fm4u',country:'KR',name:'MBC FM4U',officialUrl:'https://miniwebapp.imbc.com/',status:'candidate',authorizedUses:[]},
  {id:'kr-kbs-coolfm',country:'KR',name:'KBS Cool FM',officialUrl:'https://www.kbs.co.kr/',status:'candidate',authorizedUses:[]},
  {id:'kr-mapo-fm',country:'KR',name:'Mapo FM',officialUrl:'https://mapofm.net/',status:'candidate',authorizedUses:[]}
];
export function canUseTiloRadioSource(source:TiloRadioSource,use:LearningUse,now=new Date()):boolean {
  return source.status==='licensed'
    && !!source.licenseReference?.trim()
    && source.authorizedUses.includes(use)
    && (!source.expiresAt || (Number.isFinite(Date.parse(source.expiresAt)) && Date.parse(source.expiresAt)>now.getTime()));
}
export interface DjTrainingObservation {
  country:TiloCountry;
  sourceId:string;
  segmentKind:'opening'|'transition'|'track_intro'|'weather'|'news'|'closing';
  durationSeconds:number;
  pace:'slow'|'medium'|'fast';
  tone:'bright'|'warm'|'calm'|'serious';
  commentary?:string;
}
export function validateDjObservation(source:TiloRadioSource,observation:DjTrainingObservation):boolean {
  return source.id===observation.sourceId
    && source.country===observation.country
    && canUseTiloRadioSource(source,'analyze')
    && Number.isFinite(observation.durationSeconds)
    && observation.durationSeconds>0
    && observation.durationSeconds<=3600
    && (!observation.commentary || observation.commentary.length<=2000);
}
