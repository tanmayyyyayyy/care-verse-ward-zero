'use strict';

const axios = require('axios');
const Patient = require('../models/Patient');
const Vitals = require('../models/Vitals');
const { createAlert, buildDedupKey, resolveAlertsByType } = require('./alertService');
const { assessVitalsQuality } = require('./vitalsQuality');
const { computeEarlyWarning } = require('./earlyWarning');

const DEFAULT_AI_URL = process.env.AI_SERVICE_URL || 'http://127.0.0.1:8000';
const DEFAULT_TIMEOUT_MS = 3000;
const MIN_TREND_READINGS = 5;

/**
 * Local transparent rule-based fallback when AI service is unavailable or timed out.
 */
const ruleTrendFallback = ({ readings = [], baseline = {}, patientContext = {}, errorReason = 'AI service unavailable' }) => {
  if (!readings || readings.length < MIN_TREND_READINGS) {
    return {
      riskScore: null,
      riskLevel: 'insufficient_data',
      horizonHours: 48,
      topContributingFactors: [
        `Insufficient continuous readings (minimum ${MIN_TREND_READINGS} required; received ${readings ? readings.length : 0})`,
      ],
      confidence: 0.0,
      source: 'rule',
      safetyNotice: 'Experimental — synthetic data only. Insufficient data; do not assume patient is stable.',
      fallbackReason: errorReason,
    };
  }

  const latest = readings[readings.length - 1];
  const earliest = readings[0];
  const spanHours = Math.max(1, (new Date(latest.observedAt || latest.recordedAt).getTime() - new Date(earliest.observedAt || earliest.recordedAt).getTime()) / 3600000);

  const baseHR = Number(baseline.heartRate || 75);
  const baseSpo2 = Number(baseline.spo2 || 98);
  const baseRR = Number(baseline.respiratoryRate || 16);

  const deltaHR = latest.heartRate - baseHR;
  const deltaSpo2 = latest.spo2 - baseSpo2;
  const deltaRR = (latest.respiratoryRate || 16) - baseRR;

  const spo2Slope = (latest.spo2 - earliest.spo2) / spanHours;
  const rrSlope = ((latest.respiratoryRate || 16) - (earliest.respiratoryRate || 16)) / spanHours;
  const hrSlope = (latest.heartRate - earliest.heartRate) / spanHours;

  const newsScores = readings.map((r) =>
    computeEarlyWarning({
      heartRate: r.heartRate,
      spo2: r.spo2,
      bpSystolic: r.bpSystolic,
      respiratoryRate: r.respiratoryRate || 16,
      temperature: r.temperature || 37.0,
    }).score
  );
  const maxNews = Math.max(...newsScores, 0);
  const latestNews = newsScores[newsScores.length - 1];

  let riskLevel = 'low';
  let riskScore = 0.20;
  const factors = [];

  if (maxNews >= 7 || latest.spo2 < 90 || deltaSpo2 <= -6 || deltaRR >= 10 || spo2Slope <= -0.5) {
    riskLevel = 'high';
    riskScore = 0.88;
  } else if (maxNews >= 4 || latest.spo2 < 94 || deltaSpo2 <= -3 || deltaRR >= 5 || spo2Slope <= -0.2) {
    riskLevel = 'medium';
    riskScore = 0.55;
  }

  if (spo2Slope < -0.1) {
    factors.push(`SpO2 slope ${spo2Slope.toFixed(2)}%/h over ${spanHours.toFixed(1)}h`);
  }
  if (rrSlope > 0.2) {
    factors.push(`Respiratory rate slope +${rrSlope.toFixed(2)} breaths/min/h over ${spanHours.toFixed(1)}h`);
  }
  if (hrSlope > 0.5) {
    factors.push(`Heart rate slope +${hrSlope.toFixed(2)} bpm/h over ${spanHours.toFixed(1)}h`);
  }
  if (deltaSpo2 <= -3) {
    factors.push(`SpO2 fell by ${Math.abs(deltaSpo2)}% from baseline (${baseSpo2}%)`);
  }
  if (deltaRR >= 4) {
    factors.push(`Respiratory rate elevated (+${deltaRR} breaths/min above baseline)`);
  }
  if (deltaHR >= 15) {
    factors.push(`Heart rate elevated (+${deltaHR} bpm above baseline)`);
  }
  if (latestNews >= 4) {
    factors.push(`NEWS2 aggregate score reached ${latestNews} (peak: ${maxNews})`);
  }

  if (!factors.length) {
    factors.push('Vitals trajectory within normal baseline variation');
  }

  return {
    riskScore,
    riskLevel,
    horizonHours: 48,
    topContributingFactors: factors.slice(0, 4),
    confidence: 0.70,
    source: 'rule',
    safetyNotice: 'Experimental — synthetic data only. Rule-based trend projection (AI microservice offline).',
    fallbackReason: errorReason,
  };
};

/**
 * Call Python AI microservice POST /predict/trend with timeout and fallback.
 */
const predictTrend = async ({
  readings = [],
  baseline = null,
  patientContext = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  aiUrl = DEFAULT_AI_URL,
}) => {
  // Gate 1: Check minimum readings
  if (!readings || readings.length < MIN_TREND_READINGS) {
    return {
      riskScore: null,
      riskLevel: 'insufficient_data',
      horizonHours: 48,
      topContributingFactors: [
        `Insufficient continuous readings: minimum ${MIN_TREND_READINGS} required for trend projection (received ${readings ? readings.length : 0})`,
      ],
      confidence: 0.0,
      source: 'rule',
      safetyNotice: 'Experimental — synthetic data only. Insufficient data; do not assume patient is stable.',
    };
  }

  // Gate 2: Sensor staleness / offline check
  const latest = readings[readings.length - 1];
  const quality = assessVitalsQuality(latest);
  if (quality.status === 'offline' || quality.status === 'stale') {
    return {
      riskScore: null,
      riskLevel: 'insufficient_data',
      horizonHours: 48,
      topContributingFactors: [
        `Sensor data is ${quality.status} (${quality.message}); deterioration trend cannot be reliably projected`,
      ],
      confidence: 0.0,
      source: 'rule',
      safetyNotice: 'Experimental — synthetic data only. Sensor offline or stale; treat patient condition as unknown.',
    };
  }

  // Prepare baseline
  const effectiveBaseline = baseline || {
    heartRate: readings[0].heartRate,
    spo2: readings[0].spo2,
    bpSystolic: readings[0].bpSystolic,
    respiratoryRate: readings[0].respiratoryRate || 16,
  };

  // Prepare payload for AI microservice
  const t0 = new Date(readings[0].observedAt || readings[0].recordedAt || Date.now()).getTime();
  const payloadReadings = readings.map((r, i) => {
    const tObs = new Date(r.observedAt || r.recordedAt || Date.now()).getTime();
    const tHours = Math.max(0, (tObs - t0) / 3600000) || i;
    return {
      timestamp: r.observedAt ? new Date(r.observedAt).toISOString() : new Date().toISOString(),
      t_hours: Number(tHours.toFixed(2)),
      heart_rate: Number(r.heartRate),
      spo2: Number(r.spo2),
      bp_systolic: Number(r.bpSystolic),
      bp_diastolic: r.bpDiastolic !== undefined ? Number(r.bpDiastolic) : null,
      respiratory_rate: r.respiratoryRate !== undefined ? Number(r.respiratoryRate) : 16,
      temperature: r.temperature !== undefined ? Number(r.temperature) : 37.0,
    };
  });

  const requestBody = {
    readings: payloadReadings,
    baseline: {
      heart_rate: Number(effectiveBaseline.heartRate || 75),
      spo2: Number(effectiveBaseline.spo2 || 98),
      bp_systolic: Number(effectiveBaseline.bpSystolic || 120),
      respiratory_rate: Number(effectiveBaseline.respiratoryRate || 16),
    },
    patient_context: {
      age: Number(patientContext?.age || 60),
      condition: String(patientContext?.condition || 'general'),
      is_post_surgery: Boolean(patientContext?.isPostSurgery),
    },
    horizon_hours: 48,
  };

  try {
    const response = await axios.post(`${aiUrl}/predict/trend`, requestBody, {
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json' },
    });

    const data = response.data || {};
    return {
      riskScore: data.risk_score !== undefined ? data.risk_score : null,
      riskLevel: data.risk_level || 'low',
      horizonHours: data.horizon_hours || 48,
      topContributingFactors: data.top_contributing_factors || [],
      confidence: typeof data.confidence === 'number' ? data.confidence : 0.8,
      source: data.source || 'ml',
      safetyNotice: data.safety_notice || 'Experimental — synthetic data only.',
    };
  } catch (error) {
    const reason = error.code === 'ECONNREFUSED'
      ? 'AI service unavailable (port 8000)'
      : error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'
      ? 'AI service timed out (>3000ms)'
      : error.message;

    return ruleTrendFallback({
      readings,
      baseline: effectiveBaseline,
      patientContext,
      errorReason: reason,
    });
  }
};

/**
 * Orchestrates fetching recent readings, evaluating trend risk, persisting to Patient,
 * emitting over Socket.IO, and raising / resolving deduplicated deterioration alerts.
 */
const assessAndSyncPatientTrend = async ({ patient, io = null, actor = null }) => {
  if (!patient || !patient._id) return null;

  // Load up to 48 recent continuous non-late readings
  const rawReadings = await Vitals.find({ patient: patient._id, isLate: { $ne: true } })
    .sort({ observedAt: -1, recordedAt: -1 })
    .limit(48)
    .lean();

  const readings = rawReadings.reverse();

  // Baseline from earliest available vitals or defaults
  const baseline = readings.length
    ? {
        heartRate: readings[0].heartRate,
        spo2: readings[0].spo2,
        bpSystolic: readings[0].bpSystolic,
        respiratoryRate: readings[0].respiratoryRate || 16,
      }
    : null;

  const patientContext = {
    age: patient.age,
    condition: patient.condition,
    isPostSurgery: patient.isPostSurgery,
  };

  const prediction = await predictTrend({
    readings,
    baseline,
    patientContext,
  });

  const assessedAt = new Date();
  const updateDoc = {
    latestTrendPrediction: {
      riskScore: prediction.riskScore,
      riskLevel: prediction.riskLevel,
      horizonHours: prediction.horizonHours,
      topContributingFactors: prediction.topContributingFactors,
      confidence: prediction.confidence,
      source: prediction.source,
      assessedAt,
    },
  };

  await Patient.findByIdAndUpdate(patient._id, updateDoc);

  // Emit over Socket.IO
  if (io) {
    const socketPayload = {
      patientId: patient._id,
      patientCode: patient.patientId,
      trend: {
        ...prediction,
        assessedAt: assessedAt.toISOString(),
      },
    };

    io.to(`patient:${patient._id}`)
      .to('role:doctor')
      .to('role:nurse')
      .to('role:admin')
      .emit('trend:prediction', socketPayload);
  }

  // Manage Deterioration Risk Alerts with dedup
  const alerts = [];
  const dedupKey = buildDedupKey(patient._id, 'deterioration_risk');

  if (prediction.riskLevel === 'high' || prediction.riskLevel === 'medium') {
    const severity = prediction.riskLevel === 'high' ? 'critical' : 'warning';
    const factorSummary = prediction.topContributingFactors.length
      ? prediction.topContributingFactors.join('; ')
      : 'Trajectory indicates impending deterioration';

    const sourceTag = prediction.source === 'ml' ? 'Experimental ML trend model' : 'Rule-based trend fallback';

    const alertResult = await createAlert(
      {
        patient: patient._id,
        type: 'deterioration_risk',
        severity,
        message: `Deterioration risk projected (24-48h horizon) via ${sourceTag}: ${factorSummary}`,
        assignedTo: patient.assignedCaregiver || patient.assignedDoctor || null,
        dedupKey,
        metadata: {
          riskScore: prediction.riskScore,
          riskLevel: prediction.riskLevel,
          horizonHours: prediction.horizonHours,
          factors: prediction.topContributingFactors,
          confidence: prediction.confidence,
          source: prediction.source,
          assessedAt: assessedAt.toISOString(),
          disclaimer: 'Experimental — synthetic data only.',
        },
      },
      io
    );

    if (alertResult.created) {
      alerts.push(alertResult.alert);
    }
  } else if (prediction.riskLevel === 'low') {
    await resolveAlertsByType(
      patient._id,
      ['deterioration_risk'],
      io,
      'Trend forecast no longer projects deterioration.'
    );
  }

  return { prediction, alerts };
};

module.exports = {
  MIN_TREND_READINGS,
  predictTrend,
  ruleTrendFallback,
  assessAndSyncPatientTrend,
};
