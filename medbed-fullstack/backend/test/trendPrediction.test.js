'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MIN_TREND_READINGS,
  predictTrend,
  ruleTrendFallback,
  assessAndSyncPatientTrend,
} = require('../services/trendPredictionService');

test('Feature 2: Trend Deterioration - insufficient data returns insufficient_data and never low', async () => {
  const fewReadings = [
    { heartRate: 75, spo2: 98, bpSystolic: 120, respiratoryRate: 15, observedAt: new Date() },
    { heartRate: 74, spo2: 98, bpSystolic: 120, respiratoryRate: 15, observedAt: new Date() },
  ];

  const result = await predictTrend({
    readings: fewReadings,
    baseline: { heartRate: 75, spo2: 98, bpSystolic: 120, respiratoryRate: 15 },
  });

  assert.equal(result.riskLevel, 'insufficient_data');
  assert.equal(result.riskScore, null);
  assert.equal(result.confidence, 0.0);
  assert.equal(result.source, 'rule');
  assert.match(result.topContributingFactors[0], /insufficient/i);
  assert.notEqual(result.riskLevel, 'low', 'Must never claim low risk on insufficient data');
});

test('Feature 2: Trend Deterioration - stale/offline sensor returns insufficient_data', async () => {
  const now = Date.now();
  // 5 readings but latest was 4 hours ago (stale/offline)
  const staleReadings = [0, 1, 2, 3, 4].map((i) => ({
    heartRate: 75,
    spo2: 98,
    bpSystolic: 120,
    respiratoryRate: 15,
    observedAt: new Date(now - 14400000 + i * 300000), // 4h ago
  }));

  const result = await predictTrend({
    readings: staleReadings,
    baseline: { heartRate: 75, spo2: 98, bpSystolic: 120, respiratoryRate: 15 },
  });

  assert.equal(result.riskLevel, 'insufficient_data');
  assert.equal(result.riskScore, null);
  assert.match(result.topContributingFactors[0], /offline|stale/i);
});

test('Feature 2: Trend Deterioration - rule fallback correctly scores steady vs deteriorating trajectory', () => {
  const now = Date.now();
  // Stable readings over 5 hours
  const stableReadings = [0, 1, 2, 3, 4].map((h) => ({
    heartRate: 72 + (h % 2),
    spo2: 98,
    bpSystolic: 120,
    respiratoryRate: 15,
    observedAt: new Date(now - (5 - h) * 3600000),
  }));

  const stableResult = ruleTrendFallback({
    readings: stableReadings,
    baseline: { heartRate: 72, spo2: 98, respiratoryRate: 15 },
    errorReason: 'Test simulation fallback',
  });

  assert.equal(stableResult.riskLevel, 'low');
  assert.equal(stableResult.source, 'rule');
  assert.match(stableResult.topContributingFactors[0], /normal baseline variation|steady/i);

  // Deteriorating readings over 8 hours
  const deterioratingReadings = [
    { heartRate: 76, spo2: 98, bpSystolic: 122, respiratoryRate: 16, observedAt: new Date(now - 8 * 3600000) },
    { heartRate: 88, spo2: 95, bpSystolic: 118, respiratoryRate: 19, observedAt: new Date(now - 6 * 3600000) },
    { heartRate: 98, spo2: 92, bpSystolic: 112, respiratoryRate: 23, observedAt: new Date(now - 4 * 3600000) },
    { heartRate: 112, spo2: 89, bpSystolic: 104, respiratoryRate: 27, observedAt: new Date(now - 2 * 3600000) },
    { heartRate: 124, spo2: 86, bpSystolic: 94, respiratoryRate: 32, observedAt: new Date(now) },
  ];

  const deterioratingResult = ruleTrendFallback({
    readings: deterioratingReadings,
    baseline: { heartRate: 75, spo2: 98, respiratoryRate: 15 },
    errorReason: 'Test simulation fallback',
  });

  assert.equal(deterioratingResult.riskLevel, 'high');
  assert.equal(deterioratingResult.source, 'rule');
  assert(deterioratingResult.riskScore > 0.7);
  assert(deterioratingResult.topContributingFactors.length >= 2);
  const factorText = deterioratingResult.topContributingFactors.join(' ');
  assert.match(factorText, /SpO2|Respiratory rate|Heart rate|NEWS2/);
});

test('Feature 2: Trend Deterioration - calls AI microservice at :8000 and returns ML prediction', async () => {
  const now = Date.now();
  const readings = [0, 1, 2, 3, 4, 5].map((h) => ({
    heartRate: 72 + (h % 2),
    spo2: 98,
    bpSystolic: 120,
    respiratoryRate: 15,
    observedAt: new Date(now - (5 - h) * 20000), // fresh latest reading at now
  }));

  const result = await predictTrend({
    readings,
    baseline: { heartRate: 72, spo2: 98, bpSystolic: 120, respiratoryRate: 15 },
    patientContext: { age: 65, condition: 'general', isPostSurgery: false },
    aiUrl: 'http://127.0.0.1:8000',
  });

  assert.equal(result.source, 'ml', 'Should connect to running AI service and use ML source');
  assert(['low', 'medium'].includes(result.riskLevel));
  assert(typeof result.confidence === 'number' && result.confidence > 0.5);
  assert(Array.isArray(result.topContributingFactors));
  assert.equal(result.horizonHours, 48);
});

test('Feature 2: Trend Deterioration - falls back to rule engine when AI service is unavailable', async () => {
  const now = Date.now();
  const readings = [0, 1, 2, 3, 4, 5].map((h) => ({
    heartRate: 72,
    spo2: 98,
    bpSystolic: 120,
    respiratoryRate: 15,
    observedAt: new Date(now - (5 - h) * 20000), // fresh latest reading
  }));

  const result = await predictTrend({
    readings,
    baseline: { heartRate: 72, spo2: 98, bpSystolic: 120, respiratoryRate: 15 },
    patientContext: { age: 65, condition: 'general', isPostSurgery: false },
    aiUrl: 'http://127.0.0.1:59999', // deliberately unreachable port
    timeoutMs: 500,
  });

  assert.equal(result.source, 'rule', 'Should fall back to rule engine');
  assert.equal(result.riskLevel, 'low');
  assert.equal(result.fallbackReason, 'AI service unavailable (port 8000)');
});
