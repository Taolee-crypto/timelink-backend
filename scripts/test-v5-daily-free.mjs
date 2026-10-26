import assert from 'node:assert/strict';
import { dailyFreeCatalogue, dailyFreeProduct, quoteDailyUsage, calculatePoc,
  POC_AREAS, proposeMiningIndex, previewMining } from '../src/v5-daily-free-policy.ts';
const hour = 3_600_000;
assert.equal(dailyFreeCatalogue().length, 24);
for (let n = 1; n <= 24; n++) {
  const p = dailyFreeProduct(n);
  assert.equal(p.code, `TL-${n}`);
  assert.equal(p.monthlyPriceKrw, 900 + 1000 * n);
  assert.equal(p.miningMode, n <= 3 ? 'pooled' : 'individual');
  assert.equal(quoteDailyUsage(n, 0, n * hour).debitAtoms, 0);
}
for (const n of [0, 25, 1.5, NaN, Infinity]) assert.throws(() => dailyFreeProduct(n));
assert.equal(quoteDailyUsage(1, hour, 600_000).debitAtoms, 600 * 10_000);
assert.equal(quoteDailyUsage(1, hour - 500, 1000).debitAtoms, 5000);
assert.equal(quoteDailyUsage(1, 0, 0).nextUsedMs, 0);
assert.equal(quoteDailyUsage(1, hour, 1).debitAtoms, 10);
assert.throws(() => quoteDailyUsage(24, 24 * hour, 1));
assert.throws(() => quoteDailyUsage(1, -1, 1));
// Segmentation invariance: heartbeat frequency cannot change the bill.
let used = hour - 777, debit = 0;
for (const delta of [1, 23, 500, 1000, 9001]) {
  const result = quoteDailyUsage(1, used, delta);
  used = result.nextUsedMs; debit += result.debitAtoms;
}
assert.equal(debit, quoteDailyUsage(1, hour - 777, 10525).debitAtoms);
const weights = Object.fromEntries(POC_AREAS.map(a => [a, 1 / 6]));
const targets = Object.fromEntries(POC_AREAS.map(a => [a, 10]));
const caps = Object.fromEntries(POC_AREAS.map(a => [a, 1]));
const event = { id: 'like:1', area: 'community', points: 10, verified: true, reversed: false };
assert.ok(calculatePoc([event], weights, targets, caps) > 0);
assert.equal(calculatePoc([{...event, reversed: true}], weights, targets, caps), 0);
assert.equal(calculatePoc([{...event, verified: false}], weights, targets, caps), 0);
assert.throws(() => calculatePoc([event, event], weights, targets, caps));
assert.equal(calculatePoc([{...event, area: 'listen'}], weights, targets, caps, true), 0);
assert.throws(() => calculatePoc([], {...weights, community: 0}, targets, caps));
const base = {initialIndex: .08, currentIndex: .08, referenceVolume: 100,
  recentVolume: 100, referencePrice: 10, verifiedPrice: 10};
assert.equal(proposeMiningIndex(base), .08);
assert.equal(proposeMiningIndex({...base, recentVolume: 200}), .04);
assert.equal(proposeMiningIndex({...base, verifiedPrice: 20}), .04);
assert.equal(proposeMiningIndex({...base, recentVolume: 200, verifiedPrice: 20}), .02);
assert.equal(proposeMiningIndex({...base, currentIndex: .02, verifiedPrice: null}), .02);
assert.equal(previewMining(hour, 1, .08, 1, 1), .08);
assert.equal(previewMining(hour, 5, .08, 2, .1), .1);
assert.equal(previewMining(hour, 0, .08, 2, 1), 0);
console.log('PASS: 24 tiers, included-time boundary, overage precision, heartbeat invariance, PoC validation, downward mining index, explicit-unit preview');
