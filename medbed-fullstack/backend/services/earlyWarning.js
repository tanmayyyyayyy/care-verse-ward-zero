'use strict';

/**
 * Early-warning score modelled on the published NEWS2 aggregate scoring chart
 * (Royal College of Physicians, 2017), SpO2 Scale 1.
 *
 * This is a transparent, rule-based score. It is NOT a validated medical
 * device: it is used here to make risk explainable (every point is traceable
 * to a single vital sign) and as the shared yardstick for the trend forecast.
 *
 * Inputs missing from a home sensor kit are handled conservatively:
 *  - supplemental oxygen defaults to "room air" (0 points) unless provided
 *  - consciousness defaults to "alert" unless a caregiver note reports
 *    new confusion / drowsiness (see noteContext.js)
 */

const BANDS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

const scoreRespiratoryRate = (rr) => {
  if (rr <= 8) return 3;
  if (rr <= 11) return 1;
  if (rr <= 20) return 0;
  if (rr <= 24) return 2;
  return 3;
};

const scoreSpo2 = (spo2) => {
  if (spo2 <= 91) return 3;
  if (spo2 <= 93) return 2;
  if (spo2 <= 95) return 1;
  return 0;
};

const scoreSystolic = (sbp) => {
  if (sbp <= 90) return 3;
  if (sbp <= 100) return 2;
  if (sbp <= 110) return 1;
  if (sbp <= 219) return 0;
  return 3;
};

const scorePulse = (hr) => {
  if (hr <= 40) return 3;
  if (hr <= 50) return 1;
  if (hr <= 90) return 0;
  if (hr <= 110) return 1;
  if (hr <= 130) return 2;
  return 3;
};

const scoreTemperature = (t) => {
  if (t <= 35.0) return 3;
  if (t <= 36.0) return 1;
  if (t <= 38.0) return 0;
  if (t <= 39.0) return 1;
  return 2;
};

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

const PARAMETERS = Object.freeze([
  { key: 'respiratoryRate', label: 'Respiratory rate', unit: '/min', score: scoreRespiratoryRate },
  { key: 'spo2', label: 'SpO\u2082', unit: '%', score: scoreSpo2 },
  { key: 'bpSystolic', label: 'Systolic BP', unit: 'mmHg', score: scoreSystolic },
  { key: 'heartRate', label: 'Pulse', unit: 'bpm', score: scorePulse },
  { key: 'temperature', label: 'Temperature', unit: '\u00b0C', score: scoreTemperature },
]);

const bandFor = (total, hasSingleRed) => {
  if (total >= 7) return BANDS.HIGH;
  if (total >= 5) return BANDS.MEDIUM;
  if (hasSingleRed) return BANDS.MEDIUM; // single parameter scoring 3 => urgent review
  return BANDS.LOW;
};

const responseFor = (band, total, hasSingleRed) => {
  if (band === BANDS.HIGH) {
    return 'Emergency-level response suggested: contact the responsible clinician or emergency services now.';
  }
  if (band === BANDS.MEDIUM && total >= 5) {
    return 'Urgent review suggested: notify the responsible clinician promptly.';
  }
  if (hasSingleRed) {
    return 'One vital sign is in a high-scoring range: re-check the reading and inform the responsible clinician.';
  }
  if (total >= 1) return 'Low score: continue routine monitoring and re-check at the next interval.';
  return 'All monitored vitals are in the typical range.';
};

/**
 * @param {object} vitals {heartRate, spo2, bpSystolic, respiratoryRate, temperature}
 * @param {object} [options]
 * @param {boolean} [options.onSupplementalOxygen=false]
 * @param {boolean} [options.consciousnessAltered=false]  new confusion / drowsiness
 */
const computeEarlyWarning = (vitals = {}, options = {}) => {
  const breakdown = [];
  let total = 0;
  let hasSingleRed = false;
  const missing = [];

  for (const param of PARAMETERS) {
    const value = vitals[param.key];
    if (!isNum(value)) {
      missing.push(param.key);
      continue;
    }
    const points = param.score(value);
    if (points === 3) hasSingleRed = true;
    total += points;
    breakdown.push({
      key: param.key,
      label: param.label,
      value,
      unit: param.unit,
      points,
    });
  }

  if (options.onSupplementalOxygen) {
    total += 2;
    breakdown.push({ key: 'oxygen', label: 'Supplemental O\u2082', value: 'yes', unit: '', points: 2 });
  }

  if (options.consciousnessAltered) {
    total += 3;
    hasSingleRed = true;
    breakdown.push({
      key: 'consciousness',
      label: 'Consciousness',
      value: 'new confusion / drowsy (caregiver note)',
      unit: '',
      points: 3,
    });
  }

  const band = bandFor(total, hasSingleRed);
  const contributors = breakdown
    .filter((row) => row.points > 0)
    .sort((a, b) => b.points - a.points)
    .map((row) => `${row.label} ${row.value}${row.unit ? ` ${row.unit}` : ''} (+${row.points})`);

  return {
    total,
    band,
    hasSingleRed,
    breakdown,
    missing,
    complete: missing.length === 0,
    response: responseFor(band, total, hasSingleRed),
    summary:
      contributors.length > 0
        ? `Early-warning score ${total}: ${contributors.join(', ')}.`
        : `Early-warning score ${total}: no vital sign is outside its typical range.`,
  };
};

const maxBand = (...bands) => {
  const order = { low: 0, medium: 1, high: 2 };
  return bands.filter(Boolean).reduce((best, band) => (order[band] > order[best] ? band : best), 'low');
};

module.exports = {
  BANDS,
  PARAMETERS,
  computeEarlyWarning,
  maxBand,
  scoreRespiratoryRate,
  scoreSpo2,
  scoreSystolic,
  scorePulse,
  scoreTemperature,
};
