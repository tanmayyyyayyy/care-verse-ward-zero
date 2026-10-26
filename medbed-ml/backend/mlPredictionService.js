// backend/services/mlPredictionService.js
// ─────────────────────────────────────────────────────────────────────────────
// Node.js client for the Python ML FastAPI microservice.
// Integrates with the existing Express backend and Socket.IO.
//
// Usage in controllers:
//   const ml = require('./services/mlPredictionService');
//   const result = await ml.predictTransfer(patientData);
//   const vitals = await ml.predictVitals(vitalsWindow);
//   const safety = await ml.predictSafety(sensorData);
// ─────────────────────────────────────────────────────────────────────────────

const axios = require('axios');

const ML_BASE   = process.env.ML_SERVICE_URL || 'http://localhost:8000';
const ML_TIMEOUT= parseInt(process.env.ML_TIMEOUT_MS) || 5000; // 5s max

// ── Shared axios instance ─────────────────────────────────────────────────────
const mlClient = axios.create({
  baseURL: ML_BASE,
  timeout: ML_TIMEOUT,
  headers: { 'Content-Type': 'application/json' },
});

// ── Retry helper ──────────────────────────────────────────────────────────────
async function callML(endpoint, payload, fallback, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { data } = await mlClient.post(endpoint, payload);
      return { success: true, data };
    } catch (err) {
      if (attempt === retries) {
        console.warn(`[ML] ${endpoint} unavailable (${err.message}). Using fallback.`);
        return { success: false, data: fallback, error: err.message };
      }
      await new Promise(r => setTimeout(r, 200)); // brief retry wait
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Rule-based fallbacks (used when Python service is down)
// ══════════════════════════════════════════════════════════════════════════════

function fallbackTransfer(payload) {
  const { heart_rate, spo2, bp_systolic, age, condition, is_post_surgery } = payload;
  let score = 0;
  if (heart_rate > 110) score += 2;
  if (spo2 < 94)        score += 2;
  if (bp_systolic > 150)score += 1;
  if (age > 70)         score += 1;
  if (condition === 4)  score += 2;
  if (is_post_surgery)  score += 1;

  const risk_level = score >= 5 ? 2 : score >= 2 ? 1 : 0;
  return {
    risk_level,
    risk_label: ['Low','Medium','High'][risk_level],
    risk_probabilities: { Low: 0, Medium: 0, High: 0 },
    staff_count:        risk_level + 1,
    estimated_minutes:  Math.round((payload.transfer_distance || 100) / 30) + 5,
    fallback:           true,
  };
}

function fallbackVitals(payload) {
  const hr  = payload.heart_rate.at(-1) || 80;
  const o2  = payload.spo2.at(-1)       || 97;
  const alert_class = (hr > 115 || o2 < 90) ? 2 : (hr > 100 || o2 < 94) ? 1 : 0;
  return {
    alert_class,
    alert_label:        ['Normal','Warning','Critical'][alert_class],
    deterioration_prob: alert_class * 0.35,
    probabilities:      { Normal: 0, Warning: 0, Critical: 0 },
    fallback:           true,
  };
}

function fallbackSafety(payload) {
  const { rail_left_locked, rail_right_locked, movement_30s, gyro_roll } = payload;
  let risk = 0;
  if (!rail_left_locked)       risk += 0.25;
  if (!rail_right_locked)      risk += 0.25;
  if (movement_30s > 10)       risk += 0.25;
  if (Math.abs(gyro_roll) > 20)risk += 0.20;
  return {
    fall_risk_prob:    parseFloat(risk.toFixed(4)),
    fall_risk_label:   risk > 0.65 ? 'High' : risk > 0.35 ? 'Medium' : 'Low',
    imbalance_prob:    0,
    imbalance_detected:0,
    safety_alert:      risk > 0.65 ? 2 : risk > 0.35 ? 1 : 0,
    fallback:          true,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Public API
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Predict transfer requirements.
 * @param {object} patientData - matches TransferRequest schema
 * @returns {object} { risk_level, risk_label, staff_count, estimated_minutes, … }
 */
async function predictTransfer(patientData) {
  const result = await callML(
    '/predict/transfer',
    patientData,
    fallbackTransfer(patientData)
  );
  return result.data;
}

/**
 * Predict vitals deterioration from a time-window.
 * @param {object} vitalsWindow - { heart_rate[], spo2[], blood_pressure[], age, condition }
 */
async function predictVitals(vitalsWindow) {
  const result = await callML(
    '/predict/vitals',
    vitalsWindow,
    fallbackVitals(vitalsWindow)
  );
  return result.data;
}

/**
 * Predict fall risk and bed safety from sensor readings.
 * @param {object} sensorData - matches SafetyRequest schema
 */
async function predictSafety(sensorData) {
  const result = await callML(
    '/predict/safety',
    sensorData,
    fallbackSafety(sensorData)
  );
  return result.data;
}

/**
 * Combined prediction (all 3 models in one HTTP call).
 * @param {object} combined - { transfer?, vitals?, safety? }
 */
async function predictAll(combined) {
  const result = await callML('/predict/all', combined, {});
  return result.data;
}

/**
 * Health check against ML service.
 */
async function checkHealth() {
  try {
    const { data } = await mlClient.get('/health');
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { predictTransfer, predictVitals, predictSafety, predictAll, checkHealth };
