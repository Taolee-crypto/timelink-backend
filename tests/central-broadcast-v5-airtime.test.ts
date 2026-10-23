import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { validateAndCalculateBroadcastAirtime } from '../src/central-broadcast-v5-airtime';

const sample = () => ({
  eventId: 'broadcast_event_20261023_001', fileId: 145, creatorId: 2,
  country: 'KR', durationMs: 180000,
  audibleIntervals: [{ startMs: 0, endMs: 1000 }],
});

test('one audible second pays 0.3 TL at 70:30', () => {
  const r = validateAndCalculateBroadcastAirtime(sample());
  assert.equal(r.playedMs, 1000);
  assert.equal(r.totalAtoms, 3000);
  assert.equal(r.creatorAtoms, 2100);
  assert.equal(r.platformAtoms, 900);
});

test('only audible intervals are counted', () => {
  const r = validateAndCalculateBroadcastAirtime({ ...sample(), audibleIntervals: [
    { startMs: 0, endMs: 1000 }, { startMs: 5000, endMs: 6500 },
  ] });
  assert.equal(r.playedMs, 2500);
  assert.equal(r.totalAtoms, 7500);
});

test('overlap, reversed intervals and duration overflow fail closed', () => {
  const bad = [
    [{ startMs: 0, endMs: 1000 }, { startMs: 900, endMs: 1200 }],
    [{ startMs: 1000, endMs: 999 }],
    [{ startMs: 0, endMs: 180001 }],
  ];
  for (const audibleIntervals of bad)
    assert.throws(() => validateAndCalculateBroadcastAirtime({ ...sample(), audibleIntervals }));
});

test('same event generates same settlement key', () => {
  const first = validateAndCalculateBroadcastAirtime(sample());
  const second = validateAndCalculateBroadcastAirtime(sample());
  assert.equal(first.idempotencyKey, second.idempotencyKey);
});
