const test = require('node:test');
const assert = require('node:assert/strict');

const { computeEarlyWarning, maxBand } = require('../services/earlyWarning');
const { analyzeNote, summarizeContext } = require('../services/noteContext');
const { forecastDeterioration } = require('../services/deteriorationForecast');
const { assessPatientCare } = require('../services/careIntelligence');
const { presenceFor, median, percentile } = require('../services/caregiverService');

const NORMAL = { heartRate: 72, spo2: 98, bpSystolic: 120, respiratoryRate: 16, temperature: 36.8 };

// ── Early-warning score ─────────────────────────────────────────────────────
test('early warning: normal vitals score 0 and band low', () => {
  const ews = computeEarlyWarning(NORMAL);
  assert.equal(ews.total, 0);
  assert.equal(ews.band, 'low');
  assert.equal(ews.complete, true);
});

test('early warning: scores match the published chart boundaries', () => {
  assert.equal(computeEarlyWarning({ ...NORMAL, spo2: 91 }).breakdown.find((b) => b.key === 'spo2').points, 3);
  assert.equal(computeEarlyWarning({ ...NORMAL, spo2: 94 }).breakdown.find((b) => b.key === 'spo2').points, 1);
  assert.equal(computeEarlyWarning({ ...NORMAL, respiratoryRate: 25 }).breakdown.find((b) => b.key === 'respiratoryRate').points, 3);
  assert.equal(computeEarlyWarning({ ...NORMAL, bpSystolic: 90 }).breakdown.find((b) => b.key === 'bpSystolic').points, 3);
  assert.equal(computeEarlyWarning({ ...NORMAL, heartRate: 111 }).breakdown.find((b) => b.key === 'heartRate').points, 2);
  assert.equal(computeEarlyWarning({ ...NORMAL, temperature: 39.1 }).breakdown.find((b) => b.key === 'temperature').points, 2);
});

test('early warning: one red parameter forces at least medium; total >=7 is high', () => {
  const single = computeEarlyWarning({ ...NORMAL, spo2: 90 });
  assert.equal(single.total, 3);
  assert.equal(single.band, 'medium');
  const severe = computeEarlyWarning({ heartRate: 135, spo2: 88, bpSystolic: 85, respiratoryRate: 28, temperature: 39.5 });
  assert.equal(severe.band, 'high');
  assert.ok(severe.total >= 7);
});

test('early warning: missing vitals are reported, never invented', () => {
  const ews = computeEarlyWarning({ heartRate: 72, spo2: 98 });
  assert.equal(ews.complete, false);
  assert.deepEqual(ews.missing.sort(), ['bpSystolic', 'respiratoryRate', 'temperature']);
});

test('early warning: altered consciousness adds 3 and is explained', () => {
  const ews = computeEarlyWarning(NORMAL, { consciousnessAltered: true });
  assert.equal(ews.total, 3);
  assert.ok(ews.breakdown.some((b) => b.key === 'consciousness'));
  assert.equal(maxBand('low', 'high', 'medium'), 'high');
});

// ── Caregiver-note context ──────────────────────────────────────────────────
test('note context: detects urgent symptoms and records the matching phrase', () => {
  const flags = analyzeNote('Patient seemed confused this morning and short of breath on stairs.');
  assert.deepEqual(flags.map((f) => f.id).sort(), ['breathing_difficulty', 'confusion']);
  assert.ok(flags.every((f) => f.phrase.length > 0));
});

test('note context: negation is respected', () => {
  assert.equal(analyzeNote('No chest pain. Denies dizziness.').length, 0);
  assert.equal(analyzeNote('Not confused, talking normally').length, 0);
  assert.equal(analyzeNote('without breathlessness at rest').length, 0);
});

test('note context: reassuring notes never lower risk', () => {
  const ctx = summarizeContext([{ text: 'Slept well, feeling better', createdAt: new Date() }]);
  assert.equal(ctx.level, 'none');
  assert.equal(ctx.minimumRisk, 'low');
});

test('note context: urgent flag sets a high risk floor; old notes are ignored', () => {
  const now = Date.now();
  const recent = summarizeContext([{ text: 'chest pain since lunch', createdAt: new Date(now - 3600e3) }], { now });
  assert.equal(recent.minimumRisk, 'high');
  const old = summarizeContext([{ text: 'chest pain since lunch', createdAt: new Date(now - 48 * 3600e3) }], { now });
  assert.equal(old.minimumRisk, 'low');
});

test('note context: confusion marks consciousness altered', () => {
  const ctx = summarizeContext([{ text: 'very drowsy, hard to wake', createdAt: new Date() }]);
  assert.equal(ctx.alterConsciousness, true);
});

// ── Forecast ────────────────────────────────────────────────────────────────
const series = (n, step, base = NORMAL) =>
  Array.from({ length: n }, (_, i) => ({
    observedAt: new Date(Date.UTC(2026, 9, 28, 0, 0, i)),
    source: 'simulation',
    heartRate: base.heartRate + (step.heartRate || 0) * i,
    spo2: base.spo2 + (step.spo2 || 0) * i,
    bpSystolic: base.bpSystolic + (step.bpSystolic || 0) * i,
    respiratoryRate: base.respiratoryRate + (step.respiratoryRate || 0) * i,
    temperature: base.temperature + (step.temperature || 0) * i,
  }));

test('forecast: too few readings returns an explicit insufficient-data result', () => {
  const f = forecastDeterioration(series(3, {}));
  assert.equal(f.status, 'insufficient_data');
  assert.equal(f.deteriorationLikely, false);
  assert.equal(f.confidence, 'none');
});

test('forecast: flat vitals produce no deterioration', () => {
  const f = forecastDeterioration(series(12, {}));
  assert.equal(f.status, 'ok');
  assert.equal(f.deteriorationLikely, false);
  assert.equal(f.drivers.length, 0);
});

test('forecast: steady decline is projected to reach the urgent threshold with named drivers', () => {
  const f = forecastDeterioration(series(12, { spo2: -0.5, respiratoryRate: 0.5, heartRate: 1.5 }));
  assert.equal(f.status, 'ok');
  assert.equal(f.deteriorationLikely, true);
  assert.ok(f.hoursToUrgent > 0 && f.hoursToUrgent <= 48);
  assert.ok(f.drivers.some((d) => d.key === 'spo2' && d.worsening || d.key === 'respiratoryRate'));
  assert.match(f.message, /If current trends continue/);
});

test('forecast: projections stay inside physiological bounds', () => {
  const f = forecastDeterioration(series(14, { spo2: -3, heartRate: 12, bpSystolic: -8, respiratoryRate: 3, temperature: 0.4 }));
  for (const p of f.projections) {
    assert.ok(p.vitals.spo2 >= 50 && p.vitals.spo2 <= 100);
    assert.ok(p.vitals.heartRate <= 220);
    assert.ok(p.vitals.bpSystolic >= 50);
    assert.ok(p.vitals.temperature <= 42);
  }
});

test('forecast: confidence is never reported as high and disclaimer is always present', () => {
  const f = forecastDeterioration(series(16, { spo2: -0.3 }));
  assert.notEqual(f.confidence, 'high');
  assert.equal(f.experimental, true);
  assert.match(f.disclaimer, /not a diagnosis/i);
});

test('forecast: noisy but trendless data does not create a false alarm', () => {
  const noisy = series(16, {}).map((r, i) => ({ ...r, heartRate: 72 + (i % 2 ? 4 : -4), spo2: 98 - (i % 3 ? 0 : 1) }));
  assert.equal(forecastDeterioration(noisy).deteriorationLikely, false);
});

// ── Composite assessment ────────────────────────────────────────────────────
const live = (extra = {}) => ({
  ...NORMAL,
  observedAt: new Date(),
  recordedAt: new Date(),
  source: 'sensor',
  predictedRisk: 'low',
  assessmentSource: 'rule_based',
  ...extra,
});

test('composite: caregiver note can raise risk but explains why', () => {
  const care = assessPatientCare({
    patient: { age: 40 },
    readings: [live()],
    notes: [{ text: 'felt dizzy and vomiting after lunch', createdAt: new Date(), authorName: 'Priya' }],
  });
  assert.equal(care.risk, 'medium');
  assert.deepEqual(care.escalatedBy, ['caregiver notes']);
  assert.ok(care.reasons.some((r) => /caregiver notes/i.test(r)));
});

test('composite: confusion note adds early-warning points and raises to high', () => {
  const care = assessPatientCare({
    patient: {},
    readings: [live()],
    notes: [{ text: 'patient is confused and drowsy', createdAt: new Date() }],
  });
  assert.equal(care.news2.total, 3);
  assert.equal(care.risk, 'high');
});

test('composite: reassuring notes never lower a high vitals risk', () => {
  const care = assessPatientCare({
    patient: {},
    readings: [live({ spo2: 88, predictedRisk: 'high' })],
    notes: [{ text: 'feeling better, slept well', createdAt: new Date() }],
  });
  assert.equal(care.risk, 'high');
});

test('composite: no data or stale data yields "unknown", never "low"', () => {
  assert.equal(assessPatientCare({ patient: {}, readings: [], notes: [] }).risk, 'unknown');
  const stale = assessPatientCare({
    patient: {},
    readings: [live({ observedAt: new Date(Date.now() - 3600e3), recordedAt: new Date(Date.now() - 3600e3) })],
    notes: [],
  });
  assert.equal(stale.risk, 'unknown');
});

test('composite: higher-risk patients use a more sensitive forecast threshold and always carry a safety notice', () => {
  const senior = assessPatientCare({ patient: { age: 78 }, readings: [live()], notes: [] });
  const young = assessPatientCare({ patient: { age: 30 }, readings: [live()], notes: [] });
  assert.equal(senior.urgentThreshold, 4);
  assert.equal(young.urgentThreshold, 5);
  assert.match(senior.safetyNotice, /Not a diagnostic device/);
});

// ── Caregiver presence helpers ──────────────────────────────────────────────
test('caregiver presence: active, idle, unresponsive thresholds', () => {
  const now = Date.now();
  assert.equal(presenceFor(new Date(now - 2 * 60e3), now), 'active');
  assert.equal(presenceFor(new Date(now - 20 * 60e3), now), 'idle');
  assert.equal(presenceFor(new Date(now - 90 * 60e3), now), 'unresponsive');
});

test('caregiver metrics: median and p90 handle empty and small sets', () => {
  assert.equal(median([]), null);
  assert.equal(median([10, 30, 20]), 20);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
});
