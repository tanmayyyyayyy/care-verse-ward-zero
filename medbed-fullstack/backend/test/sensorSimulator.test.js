const test = require('node:test');
const assert = require('node:assert/strict');
const { generateScenarioReading, resetScenario, SCENARIOS } = require('../services/sensorSimulator');

const patient = { _id: 'patient-1', patientId: 'WZ-1', bed: 'Z-01' };
const random = () => 0.5;

test.beforeEach(() => resetScenario(patient._id));

test('supports exactly the documented scenarios', () => {
  assert.deepEqual([...SCENARIOS], ['stable', 'slow_decline', 'sudden_drop']);
  assert.throws(() => generateScenarioReading(patient, 'unknown'), /Unsupported scenario/);
});

test('emits stable readings in plausible ranges with provenance', () => {
  const reading = generateScenarioReading(patient, 'stable', { random });
  assert.equal(reading.scenario, 'stable');
  assert.equal(reading.source, 'simulation');
  assert.match(reading.readingId, /^sim-/);
  assert.match(reading.deviceId, /^SIM-/);
  assert.ok(reading.heartRate >= 60 && reading.heartRate <= 100);
  assert.ok(reading.spo2 >= 95 && reading.spo2 <= 100);
});

test('slow decline worsens across sequential steps', () => {
  const first = generateScenarioReading(patient, 'slow_decline', { random });
  const second = generateScenarioReading(patient, 'slow_decline', { random });
  assert.equal(first.scenarioStep, 1);
  assert.equal(second.scenarioStep, 2);
  assert.ok(second.heartRate > first.heartRate);
  assert.ok(second.spo2 < first.spo2);
});

test('sudden drop emits critical-range synthetic values', () => {
  const reading = generateScenarioReading(patient, 'sudden_drop', { random });
  assert.ok(reading.heartRate >= 120);
  assert.ok(reading.spo2 <= 92);
  assert.ok(reading.bpSystolic <= 95);
});

test('each reading gets a unique server-safe identifier', () => {
  const first = generateScenarioReading(patient, 'stable', { random });
  const second = generateScenarioReading(patient, 'stable', { random });
  assert.notEqual(first.readingId, second.readingId);
});
