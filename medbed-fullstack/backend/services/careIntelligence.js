'use strict';

const { computeEarlyWarning, maxBand } = require('./earlyWarning');
const { summarizeContext } = require('./noteContext');
const { forecastDeterioration } = require('./deteriorationForecast');
const { assessVitalsQuality } = require('./vitalsQuality');

const SAFETY_NOTICE =
  'Experimental prototype using synthetic data. Scores and forecasts support, and never replace, the judgement of a clinician or caregiver. Not a diagnostic device.';

const profileFactors = (patient = {}) => {
  const factors = [];
  if (Number(patient.age) >= 65) factors.push(`Age ${patient.age} (65+)`);
  if (patient.isPostSurgery) factors.push('Recent surgery');
  if (['cardiac', 'respiratory', 'icu'].includes(patient.condition)) {
    factors.push(`Condition: ${patient.condition}`);
  }
  return factors;
};

/**
 * Pure orchestration of the Sense -> Understand -> Predict stages.
 *
 * @param {object} args
 * @param {object} args.patient
 * @param {Array}  args.readings ascending by observedAt (most recent last)
 * @param {Array}  args.notes    caregiver notes (any order)
 * @param {number} [args.now]
 */
const assessPatientCare = ({ patient = {}, readings = [], notes = [], now = Date.now(), options = {} }) => {
  const latest = readings.length ? readings[readings.length - 1] : null;
  const quality = assessVitalsQuality(latest, now);
  const dataUsable = quality.status === 'live' || quality.status === 'recent';

  const context = summarizeContext(notes, { now });
  const factors = profileFactors(patient);
  const sensitive = factors.length > 0;
  const urgentThreshold = sensitive ? 4 : 5; // more sensitive for higher-risk patients

  const news2 = latest
    ? computeEarlyWarning(
        {
          heartRate: latest.heartRate,
          spo2: latest.spo2,
          bpSystolic: latest.bpSystolic,
          respiratoryRate: latest.respiratoryRate,
          temperature: latest.temperature,
        },
        { consciousnessAltered: context.alterConsciousness }
      )
    : null;

  const forecast = forecastDeterioration(readings, {
    consciousnessAltered: context.alterConsciousness,
    urgentThreshold,
    simMinutesPerReading: options.simMinutesPerReading,
  });

  // ---- Composite current risk (can only be raised by context, never lowered) ----
  const reasons = [];
  let risk = 'unknown';
  let escalatedBy = [];

  if (!latest) {
    reasons.push('No sensor reading is available: current state is unknown. Do not assume the patient is stable.');
  } else if (!dataUsable) {
    reasons.push(`${quality.message} Current state cannot be confirmed from stale data.`);
  } else {
    const aiRisk = latest.predictedRisk || 'low';
    risk = maxBand(aiRisk, news2.band);
    reasons.push(
      `Vitals: ${aiRisk} risk from the ${latest.assessmentSource === 'ai' ? 'ML model' : 'rule-based check'}; ${news2.summary}`
    );
  }

  if (context.level !== 'none') {
    const before = risk;
    const floor = context.minimumRisk;
    const next = risk === 'unknown' ? (floor === 'low' ? 'unknown' : floor) : maxBand(risk, floor);
    if (next !== before) {
      escalatedBy.push('caregiver notes');
      reasons.push(`Risk raised from ${before} to ${next} because of caregiver notes. ${context.summary}`);
      risk = next;
    } else {
      reasons.push(context.summary);
    }
  }

  const outlook = {
    status: forecast.status,
    likelyToWorsen: forecast.deteriorationLikely,
    worstBand: forecast.status === 'ok' ? forecast.projections.reduce((a, b) => (b.score > a.score ? b : a)).band : null,
  };
  if (forecast.deteriorationLikely) {
    reasons.push(forecast.message);
  }

  const recommendedAction = !latest || !dataUsable
    ? 'Check the sensor and the patient directly; escalate if a caregiver cannot confirm the patient is well.'
    : risk === 'high'
      ? 'Assess the patient now and contact the responsible clinician or emergency services per care plan.'
      : risk === 'medium' || forecast.deteriorationLikely
        ? 'Review the patient soon, re-check vitals, and inform the responsible clinician.'
        : 'Continue routine monitoring.';

  return {
    generatedAt: new Date(now).toISOString(),
    patientId: patient._id || null,
    patientCode: patient.patientId || null,
    dataQuality: quality,
    risk,
    news2,
    context: {
      level: context.level,
      summary: context.summary,
      flags: context.flags.map(({ id, label, level, phrase, author, at }) => ({
        id,
        label,
        level,
        phrase,
        author,
        at: new Date(at).toISOString(),
      })),
      windowHours: context.windowHours,
    },
    profileFactors: factors,
    urgentThreshold,
    forecast,
    outlook,
    escalatedBy,
    reasons,
    recommendedAction,
    safetyNotice: SAFETY_NOTICE,
  };
};

module.exports = { SAFETY_NOTICE, assessPatientCare, profileFactors };
