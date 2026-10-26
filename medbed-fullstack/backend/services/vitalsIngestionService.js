const crypto = require('crypto');
const Patient = require('../models/Patient');
const Vitals = require('../models/Vitals');
const aiService = require('./aiService');
const {
  buildVitalsAlertCandidates,
  createAlertsForAssessment,
  resolveDataQualityAlerts,
  resolveVitalsAlerts,
} = require('./alertService');
const { assessVitalsQuality } = require('./vitalsQuality');
const { recordAudit } = require('./auditService');

const toDateOrNull = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const buildAssessmentInput = (patient, payload) => ({
  heartRate: Number(payload.heartRate),
  spo2: Number(payload.spo2),
  bpSystolic: Number(payload.bpSystolic),
  bpDiastolic: Number(payload.bpDiastolic),
  age: patient.age,
  condition: patient.condition,
  isPostSurgery: patient.isPostSurgery,
});

const emitVitalsUpdate = (io, patient, vitals, assessment, quality) => {
  if (!io) return;
  const payload = {
    patientId: patient._id,
    patientCode: patient.patientId,
    vitals,
    predictedRisk: assessment.risk,
    aiFlags: assessment.flags,
    assessmentSource: assessment.source,
    assessmentExplanation: vitals.assessmentExplanation,
    fallbackReason: assessment.fallbackReason || null,
    dataQuality: quality,
    isLate: Boolean(vitals.isLate),
  };

  io.to(`patient:${patient._id}`)
    .to('role:doctor')
    .to('role:nurse')
    .to('role:admin')
    .emit('vitals:update', payload);
};

const ingestVitals = async ({ patient, payload, io = null, actor = null }) => {
  const receivedAt = new Date();
  const readingId = String(payload.readingId || `srv-${crypto.randomUUID()}`);

  const duplicate = await Vitals.findOne({ patient: patient._id, readingId });
  if (duplicate) {
    return {
      duplicate: true,
      vitals: duplicate,
      assessment: {
        risk: duplicate.predictedRisk,
        source: duplicate.assessmentSource,
        flags: duplicate.aiFlags,
        fallbackReason: duplicate.fallbackReason,
        explanation: duplicate.assessmentExplanation,
      },
      alerts: [],
      dataQuality: assessVitalsQuality(duplicate),
    };
  }

  const previous = await Vitals.findOne({ patient: patient._id }).sort({
    observedAt: -1,
    recordedAt: -1,
  });

  const deviceTimestamp = toDateOrNull(payload.deviceTimestamp);
  const previousTimestamp =
    previous?.deviceTimestamp || previous?.recordedAt || previous?.receivedAt || null;
  const isLate = Boolean(
    deviceTimestamp && previousTimestamp && deviceTimestamp < previousTimestamp
  );

  const assessmentInput = buildAssessmentInput(patient, payload);
  let assessment;

  try {
    assessment = await aiService.predictRisk(assessmentInput);
  } catch (error) {
    assessment = aiService.buildFallbackAssessment(assessmentInput, error.message);
  }

  const explanation = aiService.buildAssessmentExplanation(assessmentInput, assessment);
  const riskScore = aiService.riskScoreFromAssessment(assessment);

  let vitals;
  try {
    vitals = await Vitals.create({
      patient: patient._id,
      readingId,
      deviceId: String(payload.deviceId || 'manual').slice(0, 120),
      heartRate: Number(payload.heartRate),
      spo2: Number(payload.spo2),
      bpSystolic: Number(payload.bpSystolic),
      bpDiastolic: Number(payload.bpDiastolic),
      temperature:
        payload.temperature === undefined ? 37.0 : Number(payload.temperature),
      respiratoryRate:
        payload.respiratoryRate === undefined ? 16 : Number(payload.respiratoryRate),
      predictedRisk: assessment.risk,
      aiFlags: assessment.flags,
      assessmentSource: assessment.source,
      assessmentExplanation: explanation,
      aiRawProba: assessment.rawProba || null,
      fallbackReason: assessment.fallbackReason || null,
      deviceTimestamp,
      observedAt: deviceTimestamp || receivedAt,
      receivedAt,
      recordedAt: receivedAt,
      isLate,
      source: payload.source || 'sensor',
    });
  } catch (error) {
    if (error?.code === 11000) {
      const existing = await Vitals.findOne({ patient: patient._id, readingId });
      return {
        duplicate: true,
        vitals: existing,
        assessment: {
          risk: existing.predictedRisk,
          source: existing.assessmentSource,
          flags: existing.aiFlags,
          fallbackReason: existing.fallbackReason,
          explanation: existing.assessmentExplanation,
        },
        alerts: [],
        dataQuality: assessVitalsQuality(existing),
      };
    }
    throw error;
  }

  if (!isLate) {
    await Patient.findByIdAndUpdate(patient._id, {
      riskLevel: assessment.risk,
      riskScore,
    });
    await resolveDataQualityAlerts(patient._id, io);
  }

  const hasBreach = buildVitalsAlertCandidates({ patient, vitals, assessment }).length > 0;
  const alerts = !isLate
    ? await createAlertsForAssessment({
        patient,
        vitals,
        assessment,
        io,
      })
    : [];

  if (!isLate && !hasBreach) {
    await resolveVitalsAlerts(patient._id, io);
  }

  await recordAudit({
    action: 'vitals_ingested',
    entityType: 'Vitals',
    entityId: vitals._id,
    patient: patient._id,
    actor: actor?._id || null,
    actorRole: actor?.role || '',
    metadata: {
      readingId: vitals.readingId,
      deviceId: vitals.deviceId,
      source: vitals.source,
      assessmentSource: vitals.assessmentSource,
      predictedRisk: vitals.predictedRisk,
      isLate,
      alertIds: alerts.map((alert) => alert._id),
    },
  });

  const dataQuality = assessVitalsQuality(vitals);
  emitVitalsUpdate(io, patient, vitals, assessment, dataQuality);

  return {
    duplicate: false,
    vitals,
    assessment: {
      ...assessment,
      explanation,
      riskScore,
    },
    alerts,
    dataQuality,
    isLate,
    actor,
  };
};

module.exports = {
  buildAssessmentInput,
  ingestVitals,
};
