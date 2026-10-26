const test = require('node:test');
const assert = require('node:assert/strict');
const { ACTIVE_ALERT_FILTER, buildDedupKey, buildVitalsAlertCandidates } = require('../services/alertService');

test('active alert filter excludes dismissed and resolved alerts', () => {
  assert.deepEqual(ACTIVE_ALERT_FILTER, { isDismissed: false, resolvedAt: null });
});

test('builds stable per-patient/per-type dedup keys', () => {
  assert.equal(buildDedupKey('abc', 'spo2_low'), 'abc:spo2_low');
  assert.notEqual(buildDedupKey('abc', 'spo2_low'), buildDedupKey('abc', 'hr_high'));
});

test('produces no alert candidates for a normal assessment', () => {
  const candidates = buildVitalsAlertCandidates({
    patient: { _id: 'p1' },
    vitals: { heartRate: 78, spo2: 98, bpSystolic: 120, bpDiastolic: 78 },
    assessment: { risk: 'low', source: 'ai', flags: { hrAlert: false, spo2Alert: false, bpAlert: false } },
  });
  assert.deepEqual(candidates, []);
});

test('adds low-BP and risk alerts even without an AI flag', () => {
  const candidates = buildVitalsAlertCandidates({
    patient: { _id: 'p1' },
    vitals: { heartRate: 78, spo2: 98, bpSystolic: 70, bpDiastolic: 45 },
    assessment: { risk: 'high', source: 'fallback', flags: {} },
  });
  assert.deepEqual(candidates.map((c) => c.type), ['bp_low']);
});
