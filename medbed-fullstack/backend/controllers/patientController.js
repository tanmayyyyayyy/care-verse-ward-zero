const Patient = require('../models/Patient');
const Vitals = require('../models/Vitals');
const { AppError } = require('../middleware/errorHandler');
const { ingestVitals } = require('../services/vitalsIngestionService');
const { assessVitalsQuality } = require('../services/vitalsQuality');
const { recordAudit } = require('../services/auditService');
const { resolveAllAlertsForPatient } = require('../services/alertService');

const getLatestVitalsMap = async (patientIds) => {
  if (!patientIds.length) return new Map();

  const rows = await Vitals.aggregate([
    { $match: { patient: { $in: patientIds } } },
    { $sort: { patient: 1, observedAt: -1, recordedAt: -1 } },
    { $group: { _id: '$patient', latest: { $first: '$$ROOT' } } },
  ]);

  return new Map(rows.map((row) => [String(row._id), row.latest]));
};

const withLatestVitals = (patient, latestVitals, now = Date.now()) => {
  const data = patient.toObject ? patient.toObject() : { ...patient };
  data.latestVitals = latestVitals || null;
  data.dataQuality = assessVitalsQuality(latestVitals, now);
  return data;
};

exports.getAllPatients = async (req, res, next) => {
  try {
    const { risk, condition, ward, search } = req.query;
    const filter = { isActive: true };

    if (risk) filter.riskLevel = risk;
    if (condition) filter.condition = condition;
    if (ward) filter.ward = ward;
    if (search) filter.name = { $regex: search, $options: 'i' };

    const patients = await Patient.find(filter)
      .populate('assignedDoctor', 'name email')
      .sort({ createdAt: -1 });

    const latestMap = await getLatestVitalsMap(patients.map((patient) => patient._id));
    const now = Date.now();
    const data = patients.map((patient) =>
      withLatestVitals(
        patient,
        latestMap.get(String(patient._id)) || null,
        now
      )
    );

    res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    next(error);
  }
};

exports.getPatient = async (req, res, next) => {
  try {
    const patient = await Patient.findById(req.params.id).populate(
      'assignedDoctor',
      'name email role'
    );
    if (!patient) return next(new AppError('Patient not found.', 404));

    const latest = await Vitals.findOne({ patient: patient._id }).sort({
      observedAt: -1,
      recordedAt: -1,
    });

    res.status(200).json({
      success: true,
      data: withLatestVitals(patient, latest),
    });
  } catch (error) {
    next(error);
  }
};

exports.createPatient = async (req, res, next) => {
  try {
    const patient = await Patient.create(req.body);
    await recordAudit({
      action: 'patient_created',
      entityType: 'Patient',
      entityId: patient._id,
      patient: patient._id,
      actor: req.user?._id || null,
      actorRole: req.user?.role || '',
      metadata: { patientId: patient.patientId },
    });
    res.status(201).json({ success: true, data: patient });
  } catch (error) {
    next(error);
  }
};

exports.updatePatient = async (req, res, next) => {
  try {
    const patient = await Patient.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!patient) return next(new AppError('Patient not found.', 404));

    await recordAudit({
      action: 'patient_updated',
      entityType: 'Patient',
      entityId: patient._id,
      patient: patient._id,
      actor: req.user?._id || null,
      actorRole: req.user?.role || '',
      metadata: { fields: Object.keys(req.body || {}) },
    });

    res.status(200).json({ success: true, data: patient });
  } catch (error) {
    next(error);
  }
};

exports.deletePatient = async (req, res, next) => {
  try {
    const patient = await Patient.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );
    if (!patient) return next(new AppError('Patient not found.', 404));

    const resolvedAlerts = await resolveAllAlertsForPatient(
      patient._id,
      req.app.get('io'),
      'Patient was deactivated.'
    );

    await recordAudit({
      action: 'patient_deactivated',
      entityType: 'Patient',
      entityId: patient._id,
      patient: patient._id,
      actor: req.user?._id || null,
      actorRole: req.user?.role || '',
      metadata: { resolvedAlertCount: resolvedAlerts.length },
    });

    res.status(200).json({ success: true, message: 'Patient deactivated.' });
  } catch (error) {
    next(error);
  }
};

exports.recordVitals = async (req, res, next) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient || !patient.isActive) {
      return next(new AppError('Active patient not found.', 404));
    }

    const result = await ingestVitals({
      patient,
      payload: req.body,
      io: req.app.get('io'),
      actor: req.user,
    });

    if (result.duplicate) {
      return res.status(200).json({
        success: true,
        duplicate: true,
        message: 'Duplicate reading ignored.',
        data: result.vitals,
        predictedRisk: result.assessment.risk,
        aiFlags: result.assessment.flags,
        assessmentSource: result.assessment.source,
        assessmentExplanation: result.assessment.explanation,
        fallbackReason: result.assessment.fallbackReason || null,
        dataQuality: result.dataQuality,
      });
    }

    res.status(201).json({
      success: true,
      duplicate: false,
      data: result.vitals,
      predictedRisk: result.assessment.risk,
      aiFlags: result.assessment.flags,
      assessmentSource: result.assessment.source,
      assessmentExplanation: result.assessment.explanation,
      fallbackReason: result.assessment.fallbackReason || null,
      riskScore: result.assessment.riskScore,
      isLate: result.isLate,
      dataQuality: result.dataQuality,
      alerts: result.alerts,
    });
  } catch (error) {
    next(error);
  }
};

exports.getVitals = async (req, res, next) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, requestedLimit))
      : 50;

    const vitals = await Vitals.find({ patient: req.params.id })
      .sort({ observedAt: -1, recordedAt: -1 })
      .limit(limit);

    res.status(200).json({
      success: true,
      count: vitals.length,
      data: vitals,
      dataQuality: assessVitalsQuality(vitals[0] || null),
    });
  } catch (error) {
    next(error);
  }
};
