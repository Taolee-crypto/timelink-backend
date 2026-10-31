/**
 * Admin-only TILO station diagnostics: a service account and a playlist are NOT
 * proof of an independent broadcast stream or payable music airtime.
 */
export type TiloStationCondition =
  | 'SERVICE_DISABLED'
  | 'NO_COUNTRY_RIGHTS'
  | 'NO_RECEIVER_TRACKS'
  | 'VERIFIED_AIRTIME_RECENT'
  | 'VERIFIED_AIRTIME_STALE'
  | 'NO_VERIFIED_AIRTIME';

export function classifyTiloStationOperation(input: {
  serviceEnabled: boolean;
  receiverTracks: number;
  licensedTracks: number;
  lastVerifiedEndAt: string | null;
  nowMs: number;
}): TiloStationCondition {
  if (!input.serviceEnabled) return 'SERVICE_DISABLED';
  if (!Number.isSafeInteger(input.licensedTracks) || input.licensedTracks <= 0)
    return 'NO_COUNTRY_RIGHTS';
  if (!Number.isSafeInteger(input.receiverTracks) || input.receiverTracks <= 0)
    return 'NO_RECEIVER_TRACKS';
  if (!input.lastVerifiedEndAt) return 'NO_VERIFIED_AIRTIME';
  const last = Date.parse(input.lastVerifiedEndAt);
  if (!Number.isFinite(last) || last > input.nowMs + 60_000)
    return 'VERIFIED_AIRTIME_STALE';
  return input.nowMs - last <= 300_000
    ? 'VERIFIED_AIRTIME_RECENT' : 'VERIFIED_AIRTIME_STALE';
}

export function isTiloStreamVerified(_input: {lastVerifiedEndAt:string|null}): false {
  // Verified airtime confirms a past event, never a perpetually running server stream.
  return false;
}
