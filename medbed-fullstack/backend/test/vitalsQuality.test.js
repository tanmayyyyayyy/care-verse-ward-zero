const test = require('node:test');
const assert = require('node:assert/strict');
const { assessVitalsQuality } = require('../services/vitalsQuality');

const at = (iso) => new Date(iso);

test('returns no_data when no reading exists and never reports stable', () => {
  const quality = assessVitalsQuality(null, at('2026-10-26T12:00:00.000Z').getTime());
  assert.equal(quality.status, 'no_data');
  assert.equal(quality.isLive, false);
  assert.equal(quality.isStale, true);
  assert.match(quality.message, /must not be assumed/i);
});

test('classifies fresh, stale, and offline readings', () => {
  const now = at('2026-10-26T12:05:00.000Z').getTime();
  const reading = { observedAt: at('2026-10-26T12:04:30.000Z') };
  assert.equal(assessVitalsQuality(reading, now).status, 'live');

  reading.observedAt = at('2026-10-26T12:03:30.000Z');
  assert.equal(assessVitalsQuality(reading, now).status, 'stale');

  reading.observedAt = at('2026-10-26T12:01:00.000Z');
  assert.equal(assessVitalsQuality(reading, now).status, 'offline');
});

test('prefers observedAt over deviceTimestamp and recordedAt', () => {
  const now = at('2026-10-26T12:05:00.000Z').getTime();
  const reading = {
    observedAt: at('2026-10-26T12:04:50.000Z'),
    deviceTimestamp: at('2026-10-26T11:00:00.000Z'),
    recordedAt: at('2026-10-26T11:00:00.000Z'),
  };
  assert.equal(assessVitalsQuality(reading, now).status, 'live');
});

test('honors configurable thresholds', () => {
  const now = at('2026-10-26T12:05:00.000Z').getTime();
  const reading = { observedAt: at('2026-10-26T12:04:00.000Z') };
  const quality = assessVitalsQuality(reading, now, { staleSeconds: 30, offlineSeconds: 300 });
  assert.equal(quality.status, 'stale');
  assert.equal(quality.thresholds.staleSeconds, 30);
});
