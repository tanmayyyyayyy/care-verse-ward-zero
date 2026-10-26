const Patient = require('../models/Patient');
const Vitals = require('../models/Vitals');
const { Alert } = require('../models/index');
const { buildDedupKey, createAlert, ACTIVE_ALERT_FILTER } = require('./alertService');
const { assessVitalsQuality } = require('./vitalsQuality');
const { recordAudit } = require('./auditService');

const ACK_TIMEOUT_SECONDS = Number(process.env.ALERT_ACK_TIMEOUT_SECONDS) || 300;
const MONITOR_INTERVAL_MS = Number(process.env.PATIENT_MONITOR_INTERVAL_MS) || 15000;

const loadLatestVitals = async () => {
  const rows = await Vitals.aggregate([
    { $sort: { patient: 1, observedAt: -1, recordedAt: -1 } },
    { $group: { _id: '$patient', latest: { $first: '$$ROOT' } } },
  ]);
  return new Map(rows.map((row) => [String(row._id), row.latest]));
};

const runDataQualityMonitor = async (io = null, now = Date.now()) => {
  const patients = await Patient.find({ isActive: true }).select(
    'patientId name assignedDoctor'
  );
  const latestByPatient = await loadLatestVitals();
  const created = [];

  for (const patient of patients) {
    const latest = latestByPatient.get(String(patient._id));
    if (!latest) {
      const result = await createAlert(
        {
          patient: patient._id,
          type: 'sensor_offline',
          severity: 'warning',
          message: `${patient.name}: No sensor readings received. Current state is unknown; do not assume stability.`,
          assignedTo: patient.assignedDoctor || null,
          dedupKey: buildDedupKey(patient._id, 'sensor_offline'),
          metadata: { dataQuality: assessVitalsQuality(null, now) },
        },
        io
      );
      if (result.created) created.push(result.alert);
      continue;
    }

    const quality = assessVitalsQuality(latest, now);
    if (quality.status !== 'stale' && quality.status !== 'offline') continue;

    const result = await createAlert(
      {
        patient: patient._id,
        type: quality.status === 'offline' ? 'sensor_offline' : 'data_stale',
        severity: quality.status === 'offline' ? 'critical' : 'warning',
        message: `${patient.name}: ${quality.message}`,
        assignedTo: patient.assignedDoctor || null,
        sourceReadingId: latest.readingId || null,
        dedupKey: buildDedupKey(patient._id, quality.status === 'offline' ? 'sensor_offline' : 'data_stale'),
        metadata: {
          dataQuality: quality,
          readingRecordedAt: latest.recordedAt,
        },
      },
      io
    );
    if (result.created) created.push(result.alert);
  }

  return created;
};

const runEscalationCycle = async (io = null, now = Date.now()) => {
  const alerts = await Alert.find({
    ...ACTIVE_ALERT_FILTER,
    isAcknowledged: false,
    escalationLevel: { $lt: 2 },
  });

  const escalated = [];

  for (const alert of alerts) {
    const level = Number(alert.escalationLevel || 0);
    const dueAt = new Date(alert.createdAt).getTime() + (level + 1) * ACK_TIMEOUT_SECONDS * 1000;
    if (now < dueAt) continue;

    const nextLevel = level + 1;
    const toRole = nextLevel === 1 ? 'doctor' : 'admin';
    alert.escalationLevel = nextLevel;
    alert.escalatedAt = new Date(now);
    alert.escalationHistory.push({
      level: nextLevel,
      at: new Date(now),
      toRole,
      reason: `Unacknowledged for ${Math.round((now - new Date(alert.createdAt).getTime()) / 1000)}s`,
    });
    await alert.save();

    if (io) {
      io.to(`role:${toRole}`).to('role:admin').emit('alert:escalated', {
        alert,
        level: nextLevel,
        toRole,
      });
    }

    await recordAudit({
      action: 'alert_escalated',
      entityType: 'Alert',
      entityId: alert._id,
      patient: alert.patient,
      metadata: { level: nextLevel, toRole },
    });

    escalated.push(alert);
  }

  return escalated;
};

const startPatientMonitor = (io = null) => {
  const run = async () => {
    try {
      await runDataQualityMonitor(io);
      await runEscalationCycle(io);
    } catch (error) {
      console.error('Patient monitor cycle failed:', error.message);
    }
  };

  const timer = setInterval(run, MONITOR_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  console.log('Patient safety monitor started');
  return { timer, run };
};

module.exports = {
  ACK_TIMEOUT_SECONDS,
  runDataQualityMonitor,
  runEscalationCycle,
  startPatientMonitor,
};
