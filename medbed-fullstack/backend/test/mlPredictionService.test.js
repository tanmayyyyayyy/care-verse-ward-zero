// backend/test/mlPredictionService.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const ml = require('../services/mlPredictionService');

test('medbed-ml health check returns ok when ML service is active', async () => {
  const health = await ml.checkHealth();
  assert.equal(typeof health, 'object');
  assert.equal(health.ok, true);
  assert.equal(health.status, 'ok');
  assert.equal(health.models_ready, 3);
  assert.ok(health.models_loaded.includes('transfer'));
  assert.ok(health.models_loaded.includes('vitals'));
  assert.ok(health.models_loaded.includes('safety'));
});

test('predictTransfer produces valid risk level, staff count, and estimated time', async () => {
  const result = await ml.predictTransfer({
    age: 67,
    weight_kg: 78.5,
    condition: 1,
    department_from: 0,
    department_to: 1,
    heart_rate: 102,
    spo2: 96,
    bp_systolic: 128,
    bp_diastolic: 82,
    transfer_distance: 180.0,
    time_of_day: 14,
    is_post_surgery: 1,
    equipment_count: 2,
  });

  assert.ok(result);
  assert.ok([0, 1, 2].includes(result.risk_level));
  assert.ok(['Low', 'Medium', 'High'].includes(result.risk_label));
  assert.ok(result.staff_count >= 1 && result.staff_count <= 4);
  assert.ok(result.estimated_minutes > 0);
  assert.equal(typeof result.inference_ms, 'number');
});

test('predictVitals evaluates time-series window with LSTM/GB ensemble', async () => {
  const result = await ml.predictVitals({
    heart_rate: [88, 92, 95, 98, 102, 104, 105, 107, 108, 110],
    spo2: [97, 97, 96, 96, 95, 95, 94, 94, 93, 93],
    blood_pressure: [118, 120, 122, 124, 126, 128, 130, 131, 132, 133],
    age: 67,
    condition: 1,
    is_post_surgery: 1,
  });

  assert.ok(result);
  assert.ok([0, 1, 2].includes(result.alert_class));
  assert.ok(['Normal', 'Warning', 'Critical'].includes(result.alert_label));
  assert.ok(typeof result.deterioration_prob === 'number');
  assert.ok(result.deterioration_prob >= 0 && result.deterioration_prob <= 1);
  assert.equal(typeof result.inference_ms, 'number');
});

test('predictSafety evaluates sensor weight, imbalance, and fall risk', async () => {
  const result = await ml.predictSafety({
    weight_kg: 78.5,
    age: 67,
    is_sedated: 0,
    sensor_head: 8.2,
    sensor_torso: 38.1,
    sensor_leg_left: 16.4,
    sensor_leg_right: 14.8,
    sensor_foot: 1.0,
    accel_x: 0.05,
    accel_y: 0.02,
    accel_z: 9.80,
    gyro_roll: 3.2,
    gyro_pitch: 1.1,
    rail_left_locked: 0,
    rail_right_locked: 1,
    bed_angle: 30.0,
    movement_30s: 4,
  });

  assert.ok(result);
  assert.ok(typeof result.fall_risk_prob === 'number');
  assert.ok(['Low', 'Medium', 'High'].includes(result.fall_risk_label));
  assert.ok([0, 1].includes(result.imbalance_detected));
  assert.ok([0, 1, 2].includes(result.safety_alert));
  assert.equal(typeof result.inference_ms, 'number');
});

test('predictAll returns predictions for multiple models in single call', async () => {
  const result = await ml.predictAll({
    transfer: {
      age: 60, weight_kg: 70, condition: 0, department_from: 0, department_to: 1,
      heart_rate: 80, spo2: 98, bp_systolic: 120, bp_diastolic: 80,
      transfer_distance: 100.0, time_of_day: 10, is_post_surgery: 0, equipment_count: 1,
    },
    safety: {
      weight_kg: 70, age: 60, is_sedated: 0, sensor_head: 7.0, sensor_torso: 35.0,
      sensor_leg_left: 14.0, sensor_leg_right: 14.0, sensor_foot: 1.0,
      accel_x: 0, accel_y: 0, accel_z: 9.81, gyro_roll: 0, gyro_pitch: 0,
      rail_left_locked: 1, rail_right_locked: 1, bed_angle: 30.0, movement_30s: 0,
    },
  });

  assert.ok(result);
  assert.ok(result.transfer);
  assert.ok(result.safety);
  assert.ok(result.transfer.risk_label);
  assert.ok(result.safety.fall_risk_label);
});
