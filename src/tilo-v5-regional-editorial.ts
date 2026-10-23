/**
 * TILO V5 regional editorial policy.
 * Pure policy layer: never fabricates news, never authorizes music playback.
 * News ingestion must be performed by a separately licensed, attributed provider.
 */
export type TiloRegion = 'KR' | 'JP' | 'US' | 'CN' | 'TH' | 'VN';
export type TiloLocale = 'ko-KR' | 'ja-JP' | 'en-US' | 'zh-CN' | 'th-TH' | 'vi-VN';
export type TiloRegionProfile = Readonly<{
  country: TiloRegion;
  locale: TiloLocale;
  timeZone: string;
  localNewsWeight: number;
  worldNewsWeight: number;
  stationId: string;
}>;
export type TiloNewsItem = Readonly<{
  id: string;
  headline: string;
  source: string;
  sourceUrl: string;
  publishedAt: string;
  country: string;
  language: string;
  verified: boolean;
  permittedForBroadcast: boolean;
}>;
export const TILO_REGIONS: Readonly<Record<TiloRegion, TiloRegionProfile>> = Object.freeze({
  KR: { country:'KR', locale:'ko-KR', timeZone:'Asia/Seoul', localNewsWeight:0.7, worldNewsWeight:0.3, stationId:'tilo-kr' },
  JP: { country:'JP', locale:'ja-JP', timeZone:'Asia/Tokyo', localNewsWeight:0.7, worldNewsWeight:0.3, stationId:'tilo-jp' },
  US: { country:'US', locale:'en-US', timeZone:'America/New_York', localNewsWeight:0.7, worldNewsWeight:0.3, stationId:'tilo-us' },
  CN: { country:'CN', locale:'zh-CN', timeZone:'Asia/Shanghai', localNewsWeight:0.7, worldNewsWeight:0.3, stationId:'tilo-cn' },
  TH: { country:'TH', locale:'th-TH', timeZone:'Asia/Bangkok', localNewsWeight:0.7, worldNewsWeight:0.3, stationId:'tilo-th' },
  VN: { country:'VN', locale:'vi-VN', timeZone:'Asia/Ho_Chi_Minh', localNewsWeight:0.7, worldNewsWeight:0.3, stationId:'tilo-vn' }
});
export function resolveTiloRegion(country: string): TiloRegionProfile {
  const key = String(country || '').trim().toUpperCase() as TiloRegion;
  return Object.prototype.hasOwnProperty.call(TILO_REGIONS, key) ? TILO_REGIONS[key] : TILO_REGIONS.KR;
}
export function selectBroadcastNews(
  items: readonly TiloNewsItem[],
  profile: TiloRegionProfile,
  now: Date,
  maxItems = 8
): TiloNewsItem[] {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid date');
  const count = Math.max(0, Math.min(30, Math.floor(Number.isFinite(maxItems) ? maxItems : 0)));
  const eligible = items.filter(item => {
    if (!item.verified || !item.permittedForBroadcast || !item.headline?.trim() ||
        !item.source?.trim() || !/^https:\/\//i.test(item.sourceUrl || '')) return false;
    const timestamp = Date.parse(item.publishedAt);
    return Number.isFinite(timestamp) && timestamp <= now.getTime() &&
      timestamp >= now.getTime() - 36 * 60 * 60 * 1000;
  });
  const sorted = [...eligible].sort((a,b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const local = sorted.filter(item => item.country.toUpperCase() === profile.country);
  const international = sorted.filter(item => item.country.toUpperCase() !== profile.country);
  const localQuota = Math.min(local.length, Math.round(count * profile.localNewsWeight));
  const chosen = [...local.slice(0, localQuota), ...international.slice(0, count - localQuota)];
  const seen = new Set(chosen.map(item => item.id));
  for (const item of sorted) {
    if (chosen.length >= count) break;
    if (!seen.has(item.id)) { chosen.push(item); seen.add(item.id); }
  }
  return chosen;
}
export function tiloEditorialInstruction(profile: TiloRegionProfile): string {
  return [
    'You are the local TILO radio DJ for ' + profile.country + '.',
    'Speak naturally and exclusively in ' + profile.locale + ' unless quoting a proper noun.',
    'Use the supplied verified, licensed headlines only; do not invent news or citations.',
    'Clearly attribute each news item to its source and distinguish facts from commentary.',
    'Do not infer political allegiance, ethnicity, religion or tragedy preferences for listeners.',
    'For sensitive events choose respectful, neutral transitions; never exploit disasters.',
    'If no verified news is supplied, omit the news segment rather than improvising.',
    'Music playback authorization, rights, territory checks and V5 billing are handled elsewhere.'
  ].join('\n');
}
