/**
 * V5 central/DJ duration-based playlist planner (pure, no streaming or billing).
 * A promotion is eligible only after an upstream authenticated inventory query
 * verifies rights, country, vocal language, active dates and remaining budget.
 */
export type TiloCandidate = {
  fileId: number; artist: string; durationMs: number;
  campaignId?: number | null; eligiblePromotion?: boolean;
};
export type TiloAirtime = { promotedMs: number; ordinaryMs: number };
export type TiloSelection = { track: TiloCandidate; kind: 'promoted' | 'ordinary' };
export type TiloPlan = {
  selections: TiloSelection[];
  projected: TiloAirtime;
  promotionShare: number;
  unfilledMs: number;
};

function validTrack(t: TiloCandidate): boolean {
  return Number.isSafeInteger(t.fileId) && t.fileId > 0 &&
    Number.isSafeInteger(t.durationMs) && t.durationMs > 0 &&
    t.durationMs <= 60 * 60 * 1000;
}
function normalizedArtist(t: TiloCandidate): string {
  return (t.artist || '').trim().toLocaleLowerCase();
}
/**
 * Eligible promotions are scheduled first, regardless of historical share.
 * Random ordinary tracks fill remaining time when promotions are insufficient.
 * Eligibility is checked upstream for both pools, independently of payment.
 * Only completed, audibly played time belongs in tilo_broadcast_airtime.
 */
export function planTiloBroadcast(
  candidates: readonly TiloCandidate[],
  alreadyPlayed: TiloAirtime,
  targetMs: number,
  recentFileIds: readonly number[] = [],
  recentArtists: readonly string[] = [],
  random: () => number = Math.random
): TiloPlan {
  if (!Number.isSafeInteger(targetMs) || targetMs < 0 || targetMs > 24 * 60 * 60 * 1000)
    throw new RangeError('Invalid planning window');
  if (![alreadyPlayed.promotedMs, alreadyPlayed.ordinaryMs].every(
    n => Number.isSafeInteger(n) && n >= 0))
    throw new RangeError('Invalid historical airtime');
  const unique = new Map<number,TiloCandidate>();
  for (const t of candidates) if (validTrack(t) && !unique.has(t.fileId)) unique.set(t.fileId,t);
  const promoted = [...unique.values()].filter(t => t.eligiblePromotion === true &&
    Number.isSafeInteger(t.campaignId) && (t.campaignId as number) > 0);
  const ordinary = [...unique.values()].filter(t => !promoted.includes(t));
  // Shuffle the ordinary pool once; payment never gates this fallback pool.
  for (let i=ordinary.length-1;i>0;i--) {
    const value=random();
    if(!Number.isFinite(value)||value<0||value>=1)throw new RangeError('Invalid random source');
    const j=Math.floor(value*(i+1));
    [ordinary[i],ordinary[j]]=[ordinary[j],ordinary[i]];
  }
  const playedIds = new Set(recentFileIds);
  const artists = new Set(recentArtists.map(a=>a.trim().toLocaleLowerCase()));
  const projected = { ...alreadyPlayed };
  const selections: TiloSelection[] = [];
  let remaining = targetMs;
  while (remaining > 0) {
    const choose = (pool: TiloCandidate[]): TiloCandidate | undefined => {
      const available = pool.filter(t => !playedIds.has(t.fileId) && t.durationMs <= remaining);
      return available.find(t => !artists.has(normalizedArtist(t))) || available[0];
    };
    const promotedPick = choose(promoted), ordinaryPick = choose(ordinary);
    const kind: 'promoted'|'ordinary' = promotedPick ? 'promoted' : 'ordinary';
    const picked = kind === 'promoted' ? promotedPick : ordinaryPick;
    if (!picked) break;
    selections.push({track:picked,kind});
    playedIds.add(picked.fileId);
    artists.add(normalizedArtist(picked));
    remaining -= picked.durationMs;
    if (kind === 'promoted') projected.promotedMs += picked.durationMs;
    else projected.ordinaryMs += picked.durationMs;
  }
  const total = projected.promotedMs + projected.ordinaryMs;
  return {selections,projected,promotionShare:total ? projected.promotedMs / total : 0,unfilledMs:remaining};
}
