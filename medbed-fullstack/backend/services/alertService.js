const { Alert } = require('../models/index');

const ACTIVE_ALERT_FILTER = Object.freeze({
  isDismissed: false,
  resolvedAt: null,
});

const buildDedupKey = (patientId, type) => `${String(patientId)}:${type}`;

const emitAlert = (io, event, payload) => {
  if (!io) return;
  const patientId = payload?.patient?._id || payload?.patient || payload?.patientId;
  let channel = io;
  if (patientId) channel = channel.to(`patient:${patientId}`);
  channel
    .to('role:doctor')
    .to('role:nurse')
    .to('role:admin')
    .emit(event, payload);
};

const createAlert = async (payload, io) => {
  const dedupKey =
    payload.dedupKey ||
    buildDedupKey(payload.patient?._id || payload.patient, payload.type);

  const existing = await Alert.findOne({ dedupKey });
  if (existing) return { alert: existing, created: false };

  try {
    const alert = await Alert.create({ ...payload, dedupKey });
    emitAlert(io, 'alert:new', alert);
    return { alert, created: true };
  } catch (error) {
    if (error?.code === 11000) {
      const alert = await Alert.findOne({ dedupKey });
      return { alert, created: false };
    }
    throw error;
  }
};

const buildVitalsAlertCandidates = ({ patient, vitals, assessment }) => {
  const flags = assessment?.flags || {};
  const source = assessment?.source === 'ai' ? 'ML estimate' : 'rule-based assessment';
  const patientId = patient?._id;
  const candidates = [];

  if (flags.hrAlert) {
    candidates.push({
      patient: patientId,
      type: 'hr_high',
      severity: vitals.heartRate > 115 ? 'critical' : 'warning',
      message: `Heart rate ${vitals.heartRate} bpm is above the configured threshold (${source}).`,
    });
  }

  if (flags.spo2Alert) {
    candidates.push({
      patient: patientId,
      type: 'spo2_low',
      severity: vitals.spo2 < 90 ? 'critical' : 'warning',
      message: `SpO2 ${vitals.spo2}% is below the configured threshold (${source}).`,
    });
  }

  if (flags.bpAlert) {
    candidates.push({
      patient: patientId,
      type: 'bp_high',
      severity:
        vitals.bpSystolic >= 160 || vitals.bpDiastolic >= 100 ? 'critical' : 'warning',
      message: `Blood pressure ${vitals.bpSystolic}/${vitals.bpDiastolic} mmHg is above the configured threshold (${source}).`,
    });
  }

  if (vitals.bpSystolic < 90 || vitals.bpDiastolic < 60) {
    candidates.push({
      patient: patientId,
      type: 'bp_low',
      severity: vitals.bpSystolic < 80 || vitals.bpDiastolic < 50 ? 'critical' : 'warning',
      message: `Blood pressure ${vitals.bpSystolic}/${vitals.bpDiastolic} mmHg is below the configured threshold.`,
    });
  }

  if (assessment?.risk === 'high' && candidates.length === 0) {
    candidates.push({
      patient: patientId,
      type: 'risk_high',
      severity: 'warning',
      message: `${source} classified this reading as high risk without an individual threshold flag.`,
    });
  }

  return candidates;
};

const createAlertsForAssessment = async ({ patient, vitals, assessment, io }) => {
  const candidates = buildVitalsAlertCandidates({ patient, vitals, assessment });
  const results = [];
  for (const candidate of candidates) {
    const result = await createAlert(
      {
        ...candidate,
        assignedTo: patient?.assignedDoctor || null,
        sourceReadingId: vitals.readingId,
        metadata: {
          assessmentSource: assessment?.source || 'fallback',
          assessmentExplanation: vitals.assessmentExplanation || '',
          readingRecordedAt: vitals.recordedAt,
        },
      },
      io
    );
    if (result.created) results.push(result.alert);
  }

  return results;
};

const VITALS_ALERT_TYPES = ['hr_high', 'spo2_low', 'bp_high', 'bp_low', 'risk_high'];

const resolveVitalsAlerts = async (patientId, io, reason = 'Vitals returned to a safe range.') => {
  const now = new Date();
  const alerts = await Alert.find({
    patient: patientId,
    type: { $in: VITALS_ALERT_TYPES },
    ...ACTIVE_ALERT_FILTER,
  });

  const resolved = [];
  for (const alert of alerts) {
    alert.resolvedAt = now;
    alert.resolvedReason = reason;
    alert.resolvedBySystem = true;
    alert.dedupKey = undefined;
    await alert.save();
    resolved.push(alert);
    emitAlert(io, 'alert:resolved', alert);
  }

  return resolved;
};

const resolveAllAlertsForPatient = async (patientId, io, reason) => {
  const now = new Date();
  const alerts = await Alert.find({ patient: patientId, ...ACTIVE_ALERT_FILTER });
  const resolved = [];
  for (const alert of alerts) {
    alert.resolvedAt = now;
    alert.resolvedReason = reason;
    alert.resolvedBySystem = true;
    alert.dedupKey = undefined;
    await alert.save();
    resolved.push(alert);
    emitAlert(io, 'alert:resolved', alert);
  }
  return resolved;
};

const resolveDataQualityAlerts = async (patientId, io) => {
  const now = new Date();
  const alerts = await Alert.find({
    patient: patientId,
    type: { $in: ['data_stale', 'sensor_offline'] },
    ...ACTIVE_ALERT_FILTER,
  });

  const resolved = [];
  for (const alert of alerts) {
    alert.resolvedAt = now;
    alert.resolvedReason = 'Fresh sensor reading received.';
    alert.resolvedBySystem = true;
    alert.dedupKey = undefined;
    await alert.save();
    resolved.push(alert);
    emitAlert(io, 'alert:resolved', alert);
  }

  return resolved;
};

module.exports = {
  ACTIVE_ALERT_FILTER,
  buildDedupKey,
  createAlert,
  buildVitalsAlertCandidates,
  createAlertsForAssessment,
  emitAlert,
  resolveAllAlertsForPatient,
  resolveDataQualityAlerts,
  resolveVitalsAlerts,
  VITALS_ALERT_TYPES,
};
