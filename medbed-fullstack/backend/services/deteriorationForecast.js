'use strict';

const { computeEarlyWarning, PARAMETERS } = require('./earlyWarning');

/**
 * Deterioration forecast: projects each vital sign forward 24 h and 48 h using
 * a least-squares trend over the recent reading window, then re-scores the
 * projected vitals with the same early-warning score used for the current state.
 *
 * Design choices for safety and honesty:
 *  - It is a TREND PROJECTION ("if current trends continue"), not a diagnosis.
 *  - A vital only contributes a trend if the fit is meaningful (R^2 gate), so
 *    sensor noise does not manufacture false alarms.
 *  - Projections are clamped to physiological bounds and a per-vital plausible
 *    maximum change, so a short steep slope cannot extrapolate to absurd values.
 *  - Confidence is capped at "moderate"; it is never reported as "high".
 *  - Too little data => explicit "insufficient data" instead of a guess.
 *  - Simulated sensors compress time, so for simulation-sourced windows each
 *    reading represents `simMinutesPerReading` minutes of virtual time.
 */

const HORIZONS_HOURS = Object.freeze([24, 48]);
const MIN_READINGS = 5;
const WINDOW_SIZES = Object.freeze([16, 8]); // recent trend matters more than old history
const MIN_SPAN_HOURS = 1;
const R2_GATE = 0.5;
const DEFAULT_SIM_MINUTES_PER_READING = Number(process.env.SIM_MINUTES_PER_READING) || 60;

const VITAL_KEYS = Object.freeze({
  heartRate: { label: 'Heart rate', unit: 'bpm', min: 30, max: 220, maxDelta: 50, decimals: 0 },
  spo2: { label: 'SpO\u2082', unit: '%', min: 50, max: 100, maxDelta: 12, decimals: 0 },
  bpSystolic: { label: 'Systolic BP', unit: 'mmHg', min: 50, max: 250, maxDelta: 50, decimals: 0 },
  respiratoryRate: { label: 'Respiratory rate', unit: '/min', min: 4, max: 50, maxDelta: 14, decimals: 0 },
  temperature: { label: 'Temperature', unit: '\u00b0C', min: 33, max: 42, maxDelta: 2.5, decimals: 1 },
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 1) => Number(v.toFixed(d));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const linearFit = (xs, ys) => {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (xs[i] - meanX) ** 2;
    sxy += (xs[i] - meanX) * (ys[i] - meanY);
    syy += (ys[i] - meanY) ** 2;
  }
  if (sxx === 0) return { slope: 0, intercept: meanY, r2: 0 };
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
};

const buildTimeAxis = (readings, simMinutesPerReading) => {
  const allSimulated = readings.every((r) => r.source === 'simulation');
  if (allSimulated) {
    return {
      mode: 'simulated',
      hours: readings.map((_, i) => (i * simMinutesPerReading) / 60),
    };
  }
  const t0 = new Date(readings[0].observedAt).getTime();
  return {
    mode: 'real',
    hours: readings.map((r) => (new Date(r.observedAt).getTime() - t0) / 3600000),
  };
};

const scoreAt = (vitals, options) => computeEarlyWarning(vitals, options);

const describeTrend = (key, meta, fit, nowValue, projected24) => {
  const direction = fit.slope > 0 ? 'rising' : 'falling';
  return `${meta.label} ${direction} ~${Math.abs(round(fit.slope, 2))} ${meta.unit}/h (${round(
    nowValue,
    meta.decimals
  )} \u2192 ${round(projected24, meta.decimals)} in 24h)`;
};

/**
 * @param {Array} readings ascending by observedAt
 * @param {object} [options]
 * @param {boolean} [options.consciousnessAltered]
 * @param {number}  [options.urgentThreshold=5] early-warning score that triggers an alert
 * @param {number}  [options.simMinutesPerReading=60]
 */
const forecastOnWindow = (readings, options, windowSize) => {
  const {
    consciousnessAltered = false,
    urgentThreshold = 5,
    simMinutesPerReading = DEFAULT_SIM_MINUTES_PER_READING,
  } = options;

  const window = readings.filter((r) => r && r.observedAt).slice(-windowSize);
  const base = {
    horizons: HORIZONS_HOURS,
    method: 'Per-vital least-squares trend, re-scored with the early-warning score',
    experimental: true,
    disclaimer:
      'Experimental trend projection on synthetic data. It shows what could happen if current trends continue; it is not a diagnosis or clinical prediction.',
  };

  if (window.length < MIN_READINGS) {
    return {
      ...base,
      status: 'insufficient_data',
      readingsUsed: window.length,
      message: `Need at least ${MIN_READINGS} readings to project a trend (have ${window.length}).`,
      deteriorationLikely: false,
      confidence: 'none',
    };
  }

  const axis = buildTimeAxis(window, simMinutesPerReading);
  const span = axis.hours[axis.hours.length - 1] - axis.hours[0];
  if (span < MIN_SPAN_HOURS) {
    return {
      ...base,
      status: 'insufficient_data',
      readingsUsed: window.length,
      message: `Readings span only ${round(span, 1)} h; at least ${MIN_SPAN_HOURS} h is needed to project a trend.`,
      deteriorationLikely: false,
      confidence: 'none',
    };
  }

  const last = window[window.length - 1];
  const currentVitals = {};
  const fits = {};
  const drivers = [];
  let rSquaredSum = 0;
  let rSquaredCount = 0;

  for (const [key, meta] of Object.entries(VITAL_KEYS)) {
    const pairs = window
      .map((r, i) => ({ x: axis.hours[i], y: Number(r[key]) }))
      .filter((p) => isNum(p.y));
    if (pairs.length < MIN_READINGS) continue;
    const fit = linearFit(
      pairs.map((p) => p.x),
      pairs.map((p) => p.y)
    );
    const tLast = pairs[pairs.length - 1].x;
    const fittedNow = fit.intercept + fit.slope * tLast;
    const nowValue = isNum(Number(last[key])) ? Number(last[key]) : fittedNow;
    currentVitals[key] = nowValue;
    fits[key] = { ...fit, tLast, nowValue, meta, trusted: fit.r2 >= R2_GATE && Math.abs(fit.slope) > 1e-6 };
    if (Math.abs(fit.slope) > 1e-6) {
      rSquaredSum += fit.r2;
      rSquaredCount += 1;
    }
  }

  const projectAt = (hours) => {
    const vitals = {};
    for (const [key, f] of Object.entries(fits)) {
      const meta = f.meta;
      const delta = f.trusted ? clamp(f.slope * hours, -meta.maxDelta, meta.maxDelta) : 0;
      vitals[key] = round(clamp(f.nowValue + delta, meta.min, meta.max), meta.decimals);
    }
    return vitals;
  };

  const currentScore = scoreAt(currentVitals, { consciousnessAltered });
  const projections = HORIZONS_HOURS.map((hours) => {
    const vitals = projectAt(hours);
    const score = scoreAt(vitals, { consciousnessAltered });
    return {
      hours,
      vitals,
      score: score.total,
      band: score.band,
      hasSingleRed: score.hasSingleRed,
      breakdown: score.breakdown,
      deltaFromNow: score.total - currentScore.total,
    };
  });

  // Hours until the projected score first reaches the urgent threshold (1h resolution, 48h horizon).
  let hoursToUrgent = null;
  if (currentScore.total < urgentThreshold) {
    for (let h = 1; h <= 48; h += 1) {
      if (scoreAt(projectAt(h), { consciousnessAltered }).total >= urgentThreshold) {
        hoursToUrgent = h;
        break;
      }
    }
  }

  const p24 = projections[0];
  for (const [key, f] of Object.entries(fits)) {
    if (!f.trusted) continue;
    const proj24 = p24.vitals[key];
    const paramNow = PARAMETERS.find((p) => p.key === key);
    const pointsNow = paramNow ? paramNow.score(f.nowValue) : 0;
    const pointsLater = paramNow ? paramNow.score(proj24) : 0;
    const worsening = pointsLater > pointsNow;
    drivers.push({
      key,
      label: f.meta.label,
      slopePerHour: round(f.slope, 3),
      r2: round(f.r2, 2),
      from: round(f.nowValue, f.meta.decimals),
      to24h: proj24,
      pointsNow,
      pointsAt24h: pointsLater,
      worsening,
      text: describeTrend(key, f.meta, f, f.nowValue, proj24),
    });
  }
  drivers.sort((a, b) => b.pointsAt24h - b.pointsNow - (a.pointsAt24h - a.pointsNow));

  const meanR2 = rSquaredCount ? rSquaredSum / rSquaredCount : 0;
  let confidence = 'low';
  if (window.length >= 10 && meanR2 >= 0.7 && span >= 3) confidence = 'moderate';

  const worstProjection = projections.reduce((a, b) => (b.score > a.score ? b : a), projections[0]);
  const reachesUrgent = worstProjection.score >= urgentThreshold && currentScore.total < urgentThreshold;
  const worseningHigh = worstProjection.band === 'high' && currentScore.band !== 'high';
  const deteriorationLikely = reachesUrgent || worseningHigh;

  const worseningDrivers = drivers.filter((d) => d.worsening).map((d) => d.text);
  let message;
  if (deteriorationLikely) {
    message =
      `If current trends continue, the early-warning score may rise from ${currentScore.total} to ${worstProjection.score} ` +
      `within ${worstProjection.hours}h` +
      (hoursToUrgent ? ` (urgent threshold reached in ~${hoursToUrgent}h)` : '') +
      (worseningDrivers.length ? `. Main drivers: ${worseningDrivers.slice(0, 3).join('; ')}.` : '.');
  } else if (currentScore.total >= urgentThreshold) {
    message =
      `The early-warning score is already at or above the urgent threshold (${currentScore.total} \u2265 ${urgentThreshold}); ` +
      `if trends continue it may reach ${worstProjection.score} within ${worstProjection.hours}h. Act on the current alerts first.`;
  } else if (drivers.length === 0) {
    message = 'No vital sign shows a consistent trend; the projection equals the current state.';
  } else {
    message = `Trends are present but projected scores stay below the urgent threshold (${urgentThreshold}) over 48h.`;
  }

  return {
    ...base,
    status: 'ok',
    timeAxis: axis.mode,
    timeAxisNote:
      axis.mode === 'simulated'
        ? `Simulated sensors: each reading represents ${simMinutesPerReading} minutes of virtual time.`
        : 'Real timestamps used.',
    readingsUsed: window.length,
    spanHours: round(span, 1),
    confidence,
    meanR2: round(meanR2, 2),
    urgentThreshold,
    currentScore: currentScore.total,
    currentBand: currentScore.band,
    projections,
    hoursToUrgent,
    drivers,
    deteriorationLikely,
    message,
    // Compact series for charting: history (virtual hours relative to last reading) + projection
    series: {
      history: window.map((r, i) => ({
        t: round(axis.hours[i] - axis.hours[axis.hours.length - 1], 2),
        heartRate: r.heartRate,
        spo2: r.spo2,
        bpSystolic: r.bpSystolic,
        respiratoryRate: r.respiratoryRate,
        temperature: r.temperature,
        score: scoreAt(
          {
            heartRate: r.heartRate,
            spo2: r.spo2,
            bpSystolic: r.bpSystolic,
            respiratoryRate: r.respiratoryRate,
            temperature: r.temperature,
          },
          { consciousnessAltered }
        ).total,
      })),
      projection: [0, 6, 12, 18, 24, 30, 36, 42, 48].map((h) => ({
        t: h,
        score: scoreAt(projectAt(h), { consciousnessAltered }).total,
      })),
    },
  };
};

/**
 * Evaluate a longer and a shorter recent window and keep the more severe
 * projection (sensitive to early change; each window is still R^2-gated, and
 * confidence stays "low" unless the longer window shows a strong, consistent fit).
 */
const forecastDeterioration = (readings = [], options = {}) => {
  const results = WINDOW_SIZES.map((size) => ({ size, result: forecastOnWindow(readings, options, size) }));
  const usable = results.filter((r) => r.result.status === 'ok');
  if (!usable.length) return { ...results[0].result, windowReadings: results[0].result.readingsUsed };
  const severity = (r) =>
    Math.max(...r.result.projections.map((p) => p.score)) - (r.result.currentScore || 0);
  const best = usable.reduce((a, b) => (severity(b) > severity(a) ? b : a), usable[0]);
  return { ...best.result, windowReadings: best.result.readingsUsed };
};

module.exports = {
  HORIZONS_HOURS,
  MIN_READINGS,
  R2_GATE,
  VITAL_KEYS,
  forecastDeterioration,
  linearFit,
};
