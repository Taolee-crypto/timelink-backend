/**
 * V5 broadcast advertising policy and privacy-preserving in-car geo matching.
 * Pure functions only: NO automatic ad playback, ledger writes or GPS persistence.
 */
export type BroadcastAudience = 'general' | 'incar' | 'cafe';
export type GeoPoint = { lat: number; lon: number };
export type AdministrativeArea = {
  /** ISO 3166-1 alpha-2, e.g. KR, US, JP. */
  countryCode: string;
  /** Provider-issued stable jurisdiction identifier; never compare localized names. */
  areaId: string;
  /** Ancestor IDs from most specific to broadest, excluding country. */
  ancestorIds?: string[];
};
export type GeoCampaign = {
  id: string;
  enabled: boolean;
  scope: 'local' | 'national';
  center?: GeoPoint;
  /** ISO country and provider-issued area IDs for worldwide administrative targeting. */
  countryCode?: string;
  targetAreaIds?: string[];
  radiusKm?: number;
  startsAt: number;
  endsAt: number;
  remainingBudget: number;
  priority?: number;
};
export type AdContext = {
  audience: BroadcastAudience;
  now: number;
  locationConsent: boolean;
  location?: GeoPoint;
  /** Resolved server-side using a versioned worldwide administrative boundary dataset. */
  administrativeArea?: AdministrativeArea;
  locationObservedAt?: number;
  previousAdAt?: number;
  minimumGapMs: number;
};

const validPoint = (p: GeoPoint | undefined): p is GeoPoint =>
  !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
  Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(Math.max(0, 1 - x)));
}

export function selectBroadcastAd(campaigns: GeoCampaign[], ctx: AdContext): GeoCampaign | null {
  // Paid cafe broadcasts are ad-free, regardless of ad source or DJ insertion.
  if (ctx.audience === 'cafe') return null;
  if (!Number.isFinite(ctx.now) || !Number.isFinite(ctx.minimumGapMs) || ctx.minimumGapMs < 0) return null;
  if (ctx.previousAdAt !== undefined && ctx.now - ctx.previousAdAt < ctx.minimumGapMs) return null;
  const freshLocation = ctx.audience === 'incar' && ctx.locationConsent &&
    validPoint(ctx.location) && ctx.locationObservedAt !== undefined &&
    ctx.locationObservedAt <= ctx.now && ctx.now - ctx.locationObservedAt <= 5 * 60_000;
  const eligible = campaigns.filter(ad => {
    if (!ad.enabled || !ad.id || !Number.isFinite(ad.remainingBudget) || ad.remainingBudget <= 0 ||
        !Number.isFinite(ad.startsAt) || !Number.isFinite(ad.endsAt) ||
        ctx.now < ad.startsAt || ctx.now >= ad.endsAt) return false;
    if (ad.scope === 'national') return true;
    if (ad.scope !== 'local' || !freshLocation) return false;
    const area = ctx.administrativeArea;
    const areaTarget = !!area && /^[A-Z]{2}$/.test(area.countryCode) &&
      ad.countryCode === area.countryCode &&
      Array.isArray(ad.targetAreaIds) && ad.targetAreaIds.length > 0 &&
      ad.targetAreaIds.some(id => [area.areaId, ...(area.ancestorIds || [])].includes(id));
    const radiusTarget = validPoint(ad.center) && Number.isFinite(ad.radiusKm) &&
      ad.radiusKm! > 0 && ad.radiusKm! <= 100 &&
      distanceKm(ctx.location!, ad.center!) <= ad.radiusKm!;
    // If country is supplied for radius targeting, do not cross the border.
    const countryAllowed = !ad.countryCode || (area && area.countryCode === ad.countryCode);
    return !!countryAllowed && (areaTarget || radiusTarget);
  });
  eligible.sort((a,b) => (a.scope === 'local' ? -1 : 0) - (b.scope === 'local' ? -1 : 0) ||
    (b.priority || 0) - (a.priority || 0) || a.id.localeCompare(b.id));
  return eligible[0] || null;
}
