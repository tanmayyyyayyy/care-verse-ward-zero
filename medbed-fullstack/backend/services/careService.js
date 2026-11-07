'use strict';

const Patient = require('../models/Patient');
const Vitals = require('../models/Vitals');
const CareNote = require('../models/CareNote');
const { assessPatientCare } = require('./careIntelligence');
const { analyzeNote, LEVELS } = require('./noteContext');
const { createAlert, buildDedupKey, resolveAlertsByType } = require('./alertService');
const { recordActivity } = require('./caregiverService');
const { recordAudit } = require('./auditService');

const READING_WINDOW = 48;
const NOTE_WINDOW_HOURS = 72;

const loadReadings = async (patientId, limit = READING_WINDOW) => {
  const rows = await Vitals.find({ patient: patientId, isLate: { $ne: true } })
    .sort({ observedAt: -1, recordedAt: -1 })
    .limit(limit)
    .lean();
  return rows.reverse();
};

const loadNotes = (patientId, now = Date.now()) =>
  CareNote.find({
    patient: patientId,
    createdAt: { $gte: new Date(now - NOTE_WINDOW_HOURS * 3600 * 1000) },
  })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();

const getPatientCare = async (patientOrId, { now = Date.now() } = {}) => {
  const patient =
    patientOrId && patientOrId._id ? patientOrId : await Patient.findById(patientOrId).lean();
  if (!patient) return null;
  const [readings, notes] = await Promise.all([
    loadReadings(patient._id),
    loadNotes(patient._id, now),
  ]);
  const care = assessPatientCare({ patient, readings, notes, now });
  return { care, notes };
};

const emitCareUpdate = (io, patient, care) => {
  if (!io) return;
  io.to(`patient:${patient._id}`)
    .to('role:doctor')
    .to('role:nurse')
    .to('role:admin')
    .emit('care:update', { patientId: String(patient._id), care });
};

/**
 * Create / resolve the forecast alert from the latest care assessment.
 * Alert severity reflects confidence: low-confidence trends produce an "info"
 * heads-up rather than a "warning", to limit alert fatigue.
 */
const syncForecastAlert = async ({ patient, care, io }) => {
  const forecast = care.forecast;
  if (forecast.status === 'ok' && forecast.deteriorationLikely && care.risk !== 'high') {
    const severity = forecast.confidence === 'moderate' ? 'warning' : 'info';
    const result = await createAlert(
      {
        patient: patient._id,
        type: 'deterioration_risk',
        severity,
        message: `Predicted deterioration (experimental): ${forecast.message}`,
        assignedTo: patient.assignedDoctor || null,
        dedupKey: buildDedupKey(patient._id, 'deterioration_risk'),
        metadata: {
          confidence: forecast.confidence,
          currentScore: forecast.currentScore,
          projections: forecast.projections.map((p) => ({ hours: p.hours, score: p.score, band: p.band })),
          drivers: forecast.drivers.filter((d) => d.worsening).map((d) => d.text),
          disclaimer: forecast.disclaimer,
        },
      },
      io
    );
    return result.created ? [result.alert] : [];
  }
  if (forecast.status === 'ok' && !forecast.deteriorationLikely) {
    await resolveAlertsByType(
      patient._id,
      ['deterioration_risk'],
      io,
      'Forecast no longer projects deterioration.'
    );
  }
  return [];
};

const addCareNote = async ({ patient, user, text, io = null }) => {
  const clean = String(text || '').trim();
  const flags = analyzeNote(clean).map(({ id, label, level, phrase }) => ({ id, label, level, phrase }));
  const note = await CareNote.create({
    patient: patient._id,
    author: user._id,
    authorName: user.name,
    authorRole: user.role,
    text: clean,
    flags,
  });

  await recordActivity(user._id, 'notes');
  await recordAudit({
    action: 'care_note_added',
    entityType: 'CareNote',
    entityId: note._id,
    patient: patient._id,
    actor: user._id,
    actorRole: user.role,
    metadata: { flags: flags.map((f) => f.id) },
  });

  const urgent = flags.filter((f) => LEVELS[f.level] >= LEVELS.urgent);
  const alerts = [];
  if (urgent.length) {
    const result = await createAlert(
      {
        patient: patient._id,
        type: 'caregiver_concern',
        severity: 'critical',
        message: `Caregiver reported: ${urgent.map((f) => f.label.toLowerCase()).join(', ')} ("${clean.slice(0, 120)}")`,
        assignedTo: patient.assignedDoctor || null,
        dedupKey: `${buildDedupKey(patient._id, 'caregiver_concern')}:${note._id}`,
        metadata: { noteId: note._id, flags: urgent, author: user.name },
      },
      io
    );
    if (result.created) alerts.push(result.alert);
  }

  const snapshot = await getPatientCare(patient);
  if (snapshot) emitCareUpdate(io, patient, snapshot.care);
  return { note, alerts, care: snapshot ? snapshot.care : null };
};

module.exports = {
  addCareNote,
  emitCareUpdate,
  getPatientCare,
  loadNotes,
  loadReadings,
  syncForecastAlert,
};
