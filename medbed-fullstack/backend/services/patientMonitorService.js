const Patient = require('../models/Patient');
const Vitals = require('../models/Vitals');
const { Alert } = require('../models/index');
const { buildDedupKey, createAlert, ACTIVE_ALERT_FILTER } = require('./alertService');
const { assessVitalsQuality } = require('./vitalsQuality');
const { recordAudit } = require('./auditService');
const { countOnDuty } = require('./caregiverService');
const CaregiverShift = require('../models/CaregiverShift');

const ACK_TIMEOUT_SECONDS = Number(process.env.ALERT_ACK_TIMEOUT_SECONDS) || 300;
const MONITOR_INTERVAL_MS = Number(process.env.PATIENT_MONITOR_INTERVAL_MS) || 15000;
const CAREGIVER_CHECKIN_TIMEOUT_SECONDS = Number(process.env.CAREGIVER_CHECKIN_TIMEOUT_SECONDS) || 1800;

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
    // Strict escalation routing: assigned caregiver (L0) -> doctor (L1) -> admin (L2)
    const toRole = nextLevel === 1 ? 'doctor' : 'admin';
    alert.escalationLevel = nextLevel;
    alert.escalatedAt = new Date(now);

    // Update assignment to reflect escalation level without triggering clinical transfer
    const patientDoc = await Patient.findById(alert.patient).select('assignedDoctor assignedCaregiver');
    if (nextLevel === 1 && patientDoc?.assignedDoctor) {
      alert.assignedTo = patientDoc.assignedDoctor;
    }

    alert.escalationHistory.push({
      level: nextLevel,
      at: new Date(now),
      toRole,
      assignedTo: alert.assignedTo || null,
      reason: `Unacknowledged for ${Math.round((now - new Date(alert.createdAt).getTime()) / 1000)}s (escalated from ${level === 0 ? 'caregiver' : 'doctor'} to ${toRole})`,
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

/**
 * Caregiver coverage: if alerts wait for acknowledgment and nobody is checked in,
 * raise one escalation to the wider team (doctor/admin) instead of letting the
 * alerts sit with an absent caregiver.
 */
const COVERAGE_GRACE_SECONDS = Number(process.env.COVERAGE_GRACE_SECONDS) || 60;
const runCoverageMonitor = async (io = null, now = Date.now()) => {
  const waiting = await Alert.find({
    ...ACTIVE_ALERT_FILTER,
    isAcknowledged: false,
    type: { $ne: 'escalation' },
    createdAt: { $lte: new Date(now - COVERAGE_GRACE_SECONDS * 1000) },
  }).sort({ createdAt: 1 });
  if (!waiting.length) return null;
  if ((await countOnDuty()) > 0) return null;

  const patient = await Patient.findById(waiting[0].patient).select('patientId name assignedDoctor');
  if (!patient) return null;
  const result = await createAlert(
    {
      patient: patient._id,
      type: 'escalation',
      severity: 'critical',
      message: `No caregiver is checked in while ${waiting.length} alert(s) await acknowledgment. Escalating beyond the care team.`,
      assignedTo: patient.assignedDoctor || null,
      dedupKey: buildDedupKey('coverage', 'none'),
      metadata: { reason: 'no_caregiver_coverage', unacknowledged: waiting.length },
    },
    io
  );
  return result.created ? result.alert : null;
};

/**
 * Missed check-in monitor: if no caregiver is on duty for a patient
 * for longer than CAREGIVER_CHECKIN_TIMEOUT_SECONDS, raise a caregiver_missed_checkin alert.
 */
const runMissedCheckinMonitor = async (io = null, now = Date.now()) => {
  const activePatients = await Patient.find({ isActive: true }).select('patientId name assignedDoctor assignedCaregiver createdAt');
  const alertsCreated = [];

  for (const patient of activePatients) {
    const query = {
      $or: [
        { patient: patient._id },
        { patients: patient._id },
      ],
      status: 'on_duty',
      checkOutAt: null,
    };
    if (patient.assignedCaregiver) {
      query.$or.push({ caregiver: patient.assignedCaregiver }, { user: patient.assignedCaregiver });
    }

    const onDutyShift = await CaregiverShift.findOne(query);
    if (onDutyShift) continue;

    const historyQuery = {
      $or: [
        { patient: patient._id },
        { patients: patient._id },
      ],
    };
    if (patient.assignedCaregiver) {
      historyQuery.$or.push({ caregiver: patient.assignedCaregiver }, { user: patient.assignedCaregiver });
    }

    const lastShift = await CaregiverShift.findOne(historyQuery).sort({ checkOutAt: -1, checkInAt: -1 });
    const lastActiveTime = lastShift
      ? new Date(lastShift.checkOutAt || lastShift.checkInAt).getTime()
      : new Date(patient.createdAt || (now - CAREGIVER_CHECKIN_TIMEOUT_SECONDS * 1000 - 1000)).getTime();

    if (now - lastActiveTime >= CAREGIVER_CHECKIN_TIMEOUT_SECONDS * 1000) {
      const caregiverPrefix = patient.assignedCaregiver ? 'Assigned caregiver' : 'Caregiver';
      const result = await createAlert(
        {
          patient: patient._id,
          type: 'caregiver_missed_checkin',
          severity: 'warning',
          message: `${caregiverPrefix} has missed check-in for patient ${patient.name} (${patient.patientId}). No caregiver on duty for >${Math.round(CAREGIVER_CHECKIN_TIMEOUT_SECONDS / 60)} min.`,
          assignedTo: patient.assignedCaregiver || patient.assignedDoctor || null,
          dedupKey: buildDedupKey(patient._id, 'caregiver_missed_checkin'),
          metadata: {
            reason: 'missed_checkin_timeout',
            timeoutSeconds: CAREGIVER_CHECKIN_TIMEOUT_SECONDS,
            lastActiveTime: new Date(lastActiveTime).toISOString(),
          },
        },
        io
      );
      if (result.created) {
        alertsCreated.push(result.alert);
      }
    }
  }

  return alertsCreated;
};

const startPatientMonitor = (io = null) => {
  const run = async () => {
    try {
      await runDataQualityMonitor(io);
      await runEscalationCycle(io);
      await runCoverageMonitor(io);
      await runMissedCheckinMonitor(io);
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
  CAREGIVER_CHECKIN_TIMEOUT_SECONDS,
  runDataQualityMonitor,
  runCoverageMonitor,
  runMissedCheckinMonitor,
  runEscalationCycle,
  startPatientMonitor,
};
