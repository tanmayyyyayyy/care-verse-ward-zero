const crypto = require('crypto');

const SCENARIOS = Object.freeze(['stable', 'slow_decline', 'sudden_drop']);
const sessions = new Map();

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const jitter = (random, amount) => (random() * 2 - 1) * amount;

const stableReading = (random) => ({
  heartRate: Math.round(clamp(78 + jitter(random, 6), 60, 100)),
  spo2: Math.round(clamp(98 + jitter(random, 1), 95, 100)),
  bpSystolic: Math.round(clamp(122 + jitter(random, 6), 105, 140)),
  bpDiastolic: Math.round(clamp(78 + jitter(random, 4), 65, 90)),
  temperature: Number((36.8 + jitter(random, 0.2)).toFixed(1)),
  respiratoryRate: Math.round(clamp(16 + jitter(random, 2), 12, 20)),
});

const slowDeclineReading = (step, random) => ({
  heartRate: Math.round(clamp(80 + step * 5 + jitter(random, 2), 60, 180)),
  spo2: Math.round(clamp(97 - step * 2 + jitter(random, 0.5), 70, 100)),
  bpSystolic: Math.round(clamp(124 - step * 5 + jitter(random, 3), 60, 160)),
  bpDiastolic: Math.round(clamp(80 - step * 3 + jitter(random, 2), 35, 100)),
  temperature: Number(clamp(37 + step * 0.15 + jitter(random, 0.1), 36, 41).toFixed(1)),
  respiratoryRate: Math.round(clamp(16 + step * 2 + jitter(random, 1), 12, 45)),
});

const suddenDropReading = (random) => ({
  heartRate: Math.round(clamp(148 + jitter(random, 8), 120, 190)),
  spo2: Math.round(clamp(82 + jitter(random, 3), 65, 92)),
  bpSystolic: Math.round(clamp(78 + jitter(random, 6), 55, 95)),
  bpDiastolic: Math.round(clamp(48 + jitter(random, 4), 30, 60)),
  temperature: Number(clamp(38.6 + jitter(random, 0.3), 37, 41).toFixed(1)),
  respiratoryRate: Math.round(clamp(33 + jitter(random, 3), 24, 45)),
});

const getSessionKey = (patient) => String(patient._id || patient.patientId);

const resetScenario = (patientId) => {
  sessions.delete(String(patientId));
};

const generateScenarioReading = (
  patient,
  scenario = 'stable',
  { random = Math.random, now = new Date() } = {}
) => {
  if (!SCENARIOS.includes(scenario)) {
    throw new Error(`Unsupported scenario: ${scenario}`);
  }

  const key = getSessionKey(patient);
  const current = sessions.get(key);
  const step = current?.scenario === scenario ? current.step + 1 : 0;

  let values;
  if (scenario === 'slow_decline') values = slowDeclineReading(step, random);
  else if (scenario === 'sudden_drop') values = suddenDropReading(random);
  else values = stableReading(random);

  sessions.set(key, { scenario, step, updatedAt: now });

  const bed = String(patient.bed || 'unknown').replace(/\s+/g, '-').toUpperCase();

  return {
    ...values,
    readingId: `sim-${crypto.randomUUID()}`,
    deviceId: `SIM-${bed}`,
    deviceTimestamp: now.toISOString(),
    source: 'simulation',
    scenario,
    scenarioStep: step + 1,
  };
};

module.exports = {
  SCENARIOS,
  generateScenarioReading,
  resetScenario,
};
