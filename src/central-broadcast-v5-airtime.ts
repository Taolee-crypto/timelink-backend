import { calculateCentralBroadcastAtoms } from './central-broadcast-v5-settlement';

/**
 * Strict server-side airtime validation boundary.
 * Never accept this evidence from a listener/browser for payout.
 * The trusted broadcaster must supply independently measured audible intervals.
 */
export type VerifiedBroadcastAirtime = {
  eventId: string;
  fileId: number;
  creatorId: number;
  country: string;
  audibleIntervals: readonly { startMs: number; endMs: number }[];
  durationMs: number;
};
export function validateAndCalculateBroadcastAirtime(event: VerifiedBroadcastAirtime) {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(event.eventId)) throw new Error('Invalid event ID');
  if (!Number.isSafeInteger(event.fileId) || event.fileId <= 0 ||
      !Number.isSafeInteger(event.creatorId) || event.creatorId <= 0 ||
      !/^[A-Z]{2}$/.test(event.country) ||
      !Number.isSafeInteger(event.durationMs) || event.durationMs <= 0 || event.durationMs > 3600000)
    throw new Error('Invalid broadcast metadata');
  if (!Array.isArray(event.audibleIntervals) || event.audibleIntervals.length === 0 ||
      event.audibleIntervals.length > 100000) throw new Error('Invalid audible intervals');
  let playedMs = 0;
  let previousEnd = 0;
  for (const interval of event.audibleIntervals) {
    if (!Number.isSafeInteger(interval.startMs) || !Number.isSafeInteger(interval.endMs) ||
        interval.startMs < previousEnd || interval.startMs < 0 ||
        interval.endMs <= interval.startMs || interval.endMs > event.durationMs)
      throw new Error('Invalid or overlapping audible interval');
    playedMs += interval.endMs - interval.startMs;
    previousEnd = interval.endMs;
  }
  const allocation = calculateCentralBroadcastAtoms(BigInt(playedMs));
  return { eventId: event.eventId, playedMs,
    totalAtoms: Number(allocation.totalAtoms),
    creatorAtoms: Number(allocation.creatorAtoms),
    platformAtoms: Number(allocation.platformAtoms),
    idempotencyKey: 'central-broadcast-v5:' + event.eventId };
}
