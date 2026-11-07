'use strict';

const Patient = require('../models/Patient');
const CareNote = require('../models/CareNote');
const { AppError } = require('../middleware/errorHandler');
const careService = require('../services/careService');
const caregiverService = require('../services/caregiverService');
const gateway = require('../services/deviceGateway');
const demoScenarioService = require('../services/demoScenarioService');
const { SCENARIOS } = require('../services/sensorSimulator');
const { recordAudit } = require('../services/auditService');
const { resolveAlertsByType } = require('../services/alertService');

const findPatientOr404 = async (id) => {
  const patient = await Patient.findById(id);
  if (!patient || !patient.isActive) throw new AppError('Active patient not found.', 404);
  return patient;
};

// ── Patient care intelligence ────────────────────────────────────────────────
exports.getIntelligence = async (req, res, next) => {
  try {
    const patient = await findPatientOr404(req.params.id);
    const snapshot = await careService.getPatientCare(patient);
    res.json({ success: true, data: snapshot.care, notes: snapshot.notes.slice(0, 20) });
  } catch (error) {
    next(error);
  }
};

exports.getOverview = async (req, res, next) => {
  try {
    const patients = await Patient.find({ isActive: true }).sort({ patientId: 1 });
    const rows = [];
    for (const patient of patients) {
      const snapshot = await careService.getPatientCare(patient);
      const care = snapshot.care;
      rows.push({
        patientId: patient._id,
        patientCode: patient.patientId,
        name: patient.name,
        bed: patient.bed,
        risk: care.risk,
        earlyWarningScore: care.news2 ? care.news2.total : null,
        dataQuality: care.dataQuality.status,
        contextLevel: care.context.level,
        forecastStatus: care.forecast.status,
        likelyToWorsen: care.outlook.likelyToWorsen,
        worstProjectedBand: care.outlook.worstBand,
        hoursToUrgent: care.forecast.hoursToUrgent ?? null,
        confidence: care.forecast.confidence,
      });
    }
    res.json({ success: true, count: rows.length, data: rows });
  } catch (error) {
    next(error);
  }
};

// ── Caregiver notes ──────────────────────────────────────────────────────────
exports.listNotes = async (req, res, next) => {
  try {
    const patient = await findPatientOr404(req.params.id);
    const notes = await CareNote.find({ patient: patient._id }).sort({ createdAt: -1 }).limit(50);
    res.json({ success: true, count: notes.length, data: notes });
  } catch (error) {
    next(error);
  }
};

exports.addNote = async (req, res, next) => {
  try {
    const patient = await findPatientOr404(req.params.id);
    const result = await careService.addCareNote({
      patient,
      user: req.user,
      text: req.body.text,
      io: req.app.get('io'),
    });
    res.status(201).json({
      success: true,
      data: result.note,
      alertsCreated: result.alerts.length,
      care: result.care,
    });
  } catch (error) {
    next(error);
  }
};

// ── Caregiver attendance & response ──────────────────────────────────────────
exports.checkIn = async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body.patients) ? req.body.patients : [];
    const { shift, created } = await caregiverService.checkIn(req.user, ids);

    // A caregiver being present clears the "nobody is covering" escalation and missed check-in alerts.
    const io = req.app.get('io');
    const open = await Patient.find({ isActive: true }).select('_id');
    for (const p of open) {
      await resolveAlertsByType(p._id, ['escalation', 'caregiver_missed_checkin'], io, 'A caregiver checked in.').catch(() => {});
    }

    await recordAudit({
      action: created ? 'caregiver_check_in' : 'caregiver_check_in_repeat',
      entityType: 'CaregiverShift',
      entityId: shift._id,
      actor: req.user._id,
      actorRole: req.user.role,
      metadata: { patients: ids },
    });
    if (io) {
      io.emit('caregiver:presence', { userId: req.user._id, onDuty: true });
      io.emit('caregiver:checkin', {
        caregiver: { id: req.user._id, name: req.user.name, role: req.user.role },
        shift,
        timestamp: new Date().toISOString(),
      });
    }
    res.status(created ? 201 : 200).json({ success: true, created, data: shift });
  } catch (error) {
    next(error);
  }
};

exports.checkOut = async (req, res, next) => {
  try {
    const shift = await caregiverService.checkOut(req.user);
    if (!shift) return next(new AppError('You are not checked in.', 409));
    await recordAudit({
      action: 'caregiver_check_out',
      entityType: 'CaregiverShift',
      entityId: shift._id,
      actor: req.user._id,
      actorRole: req.user.role,
      metadata: { activity: shift.activity },
    });
    const io = req.app.get('io');
    if (io) {
      io.emit('caregiver:presence', { userId: req.user._id, onDuty: false });
      io.emit('caregiver:checkout', {
        caregiver: { id: req.user._id, name: req.user.name, role: req.user.role },
        shift,
        timestamp: new Date().toISOString(),
      });
    }
    res.json({ success: true, data: shift });
  } catch (error) {
    next(error);
  }
};

exports.getRoster = async (req, res, next) => {
  try {
    const roster = await caregiverService.getRoster();
    const me = roster.caregivers.find((c) => c.id === String(req.user._id)) || null;
    res.json({ success: true, data: roster, me });
  } catch (error) {
    next(error);
  }
};

// ── Home gateway (resilience demo) ───────────────────────────────────────────
exports.getGateway = (req, res) => {
  res.json({ success: true, data: gateway.getStatus() });
};

exports.setConnectivity = async (req, res, next) => {
  try {
    const online = req.body.online === true || req.body.online === 'true';
    const status = await gateway.setConnectivity(online);
    await recordAudit({
      action: online ? 'gateway_reconnected' : 'gateway_link_cut',
      entityType: 'Gateway',
      actor: req.user._id,
      actorRole: req.user.role,
      metadata: { queueLength: status.queueLength },
    });
    res.json({ success: true, data: status });
  } catch (error) {
    next(error);
  }
};

exports.emitViaGateway = async (req, res, next) => {
  try {
    const scenario = String(req.body.scenario || 'stable');
    if (!SCENARIOS.includes(scenario)) {
      return next(new AppError(`Invalid scenario. Expected one of: ${SCENARIOS.join(', ')}.`, 400));
    }
    const steps = Math.max(1, Math.min(10, Number.parseInt(req.body.steps, 10) || 1));
    const patient = await findPatientOr404(req.body.patientId);
    const outcome = await gateway.emitScenario(patient, scenario, steps);
    res.status(202).json({ success: true, scenario, ...outcome });
  } catch (error) {
    next(error);
  }
};

exports.resetGateway = (req, res) => {
  res.json({ success: true, data: gateway.reset() });
};

// ── Failure Injection Panel (Admin / Doctor only, Synthetic Mode only) ────────
exports.injectFailure = async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_FAILURE_INJECTION !== 'true') {
      return next(new AppError('Failure injection disabled in production.', 403));
    }

    const action = String(req.body.action || '').trim();
    if (!action) {
      return next(new AppError('Action is required for failure injection.', 400));
    }

    const result = await gateway.injectFault(action, {
      ...req.body,
      patientId: req.body.patientId || null,
      delaySeconds: req.body.delaySeconds !== undefined ? Number(req.body.delaySeconds) : undefined,
    });

    await recordAudit({
      action: action === 'reset' ? 'failure_injection_cleared' : 'failure_injected',
      entityType: 'Gateway',
      actor: req.user._id,
      actorRole: req.user.role,
      metadata: { action, options: req.body, result },
    });

    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
};

exports.getFailureStatus = (req, res) => {
  res.json({ success: true, data: gateway.getStatus() });
};

// ── Scripted Demo Scenario Runner ─────────────────────────────────────────────
exports.runDemoStory = async (req, res, next) => {
  try {
    const isAsync = req.body.async === true || req.body.async === 'true' || req.query.async === 'true';
    const isFast = req.body.fast === true || req.body.fast === 'true' || req.query.fast === 'true';
    const speedMultiplier = Number(req.body.speedMultiplier || req.query.speedMultiplier || 1);
    const stepDelayMs = req.body.stepDelayMs !== undefined
      ? Number(req.body.stepDelayMs)
      : (req.query.stepDelayMs !== undefined ? Number(req.query.stepDelayMs) : undefined);
    const patientId = req.body.patientId || req.query.patientId || null;

    const options = {
      io: req.app.get('io'),
      actor: req.user,
      patientId,
      speedMultiplier,
      fast: isFast,
      stepDelayMs,
    };

    if (isAsync) {
      demoScenarioService.runDemoStory(options).catch((err) => {
        console.error('💥 Background Demo Story Error:', err.message);
      });
      return res.status(202).json({
        success: true,
        message: 'Demo story started in background',
        data: demoScenarioService.getDemoStatus(),
      });
    }

    const summary = await demoScenarioService.runDemoStory(options);
    res.json({
      success: true,
      message: 'Demo story completed successfully',
      data: summary,
      status: demoScenarioService.getDemoStatus(),
    });
  } catch (error) {
    next(error);
  }
};

exports.getDemoStatus = (req, res) => {
  res.json({ success: true, data: demoScenarioService.getDemoStatus() });
};

exports.cancelDemo = (req, res) => {
  const result = demoScenarioService.cancelDemo();
  res.json(result);
};
