'use strict';

const Patient = require('../models/Patient');
const Vitals = require('../models/Vitals');
const User = require('../models/User');
const { Alert } = require('../models/index');
const CareNote = require('../models/CareNote');
const caregiverService = require('./caregiverService');
const vitalsIngestionService = require('./vitalsIngestionService');
const trendPredictionService = require('./trendPredictionService');
const careService = require('./careService');
const { runEscalationCycle } = require('./patientMonitorService');
const { recordAudit } = require('./auditService');
const gateway = require('./deviceGateway');

let activeDemo = {
  isRunning: false,
  step: 0,
  totalSteps: 6,
  phase: null,
  title: null,
  description: null,
  startedAt: null,
  patientId: null,
  cancelled: false,
  error: null,
  summary: null,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getDemoStatus = () => ({
  ...activeDemo,
  elapsedMs: activeDemo.startedAt ? Date.now() - new Date(activeDemo.startedAt).getTime() : 0,
});

const cancelDemo = () => {
  if (activeDemo.isRunning) {
    activeDemo.cancelled = true;
    activeDemo.isRunning = false;
    activeDemo.phase = 'cancelled';
    activeDemo.title = 'Demo Story Cancelled';
    activeDemo.description = 'Demo was stopped by user request.';
    return { success: true, message: 'Demo cancellation requested', status: getDemoStatus() };
  }
  return { success: true, message: 'No demo is currently running', status: getDemoStatus() };
};

/**
 * Runs the 6-phase scripted demo story:
 * 1. Stable baseline (vitals normal, caregiver on duty)
 * 2. Slow decline (SpO2 drops 97->90%, HR rises, caregiver note flags dizziness & breathlessness)
 * 3. 24-48h trend risk predicted (AI/rule model flags high risk with multi-factor attribution, alert dispatched)
 * 4. Alert unacknowledged -> clinical escalation from caregiver to doctor
 * 5. Caregiver / doctor ACK & intervention note
 * 6. Physiological recovery (vitals recover, alerts resolved, full loop complete)
 */
const runDemoStory = async (options = {}) => {
  if (activeDemo.isRunning) {
    const error = new Error('A demo story is already in progress');
    error.statusCode = 409;
    throw error;
  }

  const io = options.io || null;
  const actor = options.actor || null;

  // Resolve pacing
  const isFast = options.fast === true || options.fast === 'true' || process.env.FAST_DEMO === 'true';
  const speedMultiplier = Number(options.speedMultiplier) || 1;
  const defaultStepDelay = Math.max(100, Math.round(30000 / speedMultiplier));
  const stepDelayMs = options.stepDelayMs !== undefined
    ? Number(options.stepDelayMs)
    : isFast
    ? 400
    : defaultStepDelay;

  // Reset active state
  activeDemo = {
    isRunning: true,
    step: 0,
    totalSteps: 6,
    phase: 'starting',
    title: 'Starting Demo Story',
    description: 'Initializing simulated home ward environment...',
    startedAt: new Date().toISOString(),
    patientId: null,
    cancelled: false,
    error: null,
    summary: null,
  };

  const emitStep = (stepPayload) => {
    Object.assign(activeDemo, stepPayload);
    if (io) {
      io.emit('demo:step', {
        ...getDemoStatus(),
        ...stepPayload,
      });
    }
  };

  try {
    // 0. Setup target patient and users
    let patient;
    if (options.patientId) {
      patient = await Patient.findById(options.patientId);
    }
    if (!patient) {
      patient = await Patient.findOne({ isActive: true }).sort({ patientId: 1 });
    }
    if (!patient) {
      throw new Error('No active patient available to run demo story');
    }
    activeDemo.patientId = patient._id;

    // Find or fallback caregiver and doctor
    let caregiverUser = await User.findOne({ role: 'nurse', isActive: true });
    if (!caregiverUser) caregiverUser = await User.findOne({ role: 'caregiver', isActive: true });
    if (!caregiverUser && actor) caregiverUser = actor;
    if (!caregiverUser) caregiverUser = await User.findOne({ isActive: true });

    let doctorUser = await User.findOne({ role: 'doctor', isActive: true });
    if (!doctorUser) doctorUser = await User.findOne({ role: 'admin', isActive: true });
    if (!doctorUser) doctorUser = caregiverUser;

    // Reset faults and gateway
    gateway.reset();

    // ──────────────────────────────────────────────────────────────────────────
    // Phase 1: Stable Baseline
    // ──────────────────────────────────────────────────────────────────────────
    if (activeDemo.cancelled) throw new Error('Demo cancelled');

    await caregiverService.checkIn(caregiverUser, [patient._id]);

    const stableTime = new Date();
    const stableVitals = {
      heartRate: 72,
      spo2: 98,
      bpSystolic: 120,
      bpDiastolic: 80,
      respiratoryRate: 16,
      temperature: 36.8,
      readingId: `demo-stable-${Date.now()}`,
      deviceId: 'BED-SIM-01',
      deviceTimestamp: stableTime.toISOString(),
      source: 'simulation',
    };
    await vitalsIngestionService.ingestVitals({
      patient,
      payload: stableVitals,
      io,
      actor: caregiverUser,
    });

    const initialResult = await trendPredictionService.assessAndSyncPatientTrend({ patient, io, actor: caregiverUser });
    const initialTrend = initialResult?.prediction;

    emitStep({
      step: 1,
      phase: 'stable',
      title: 'Phase 1: Stable Baseline',
      description: `${patient.name} vitals normal (HR 72, SpO2 98%). Caregiver ${caregiverUser.name} checked in and on duty.`,
      vitals: stableVitals,
      riskLevel: initialTrend?.riskLevel || 'low',
    });

    await sleep(stepDelayMs);

    // ──────────────────────────────────────────────────────────────────────────
    // Phase 2: Gradual Decline & Caregiver Observation Note
    // ──────────────────────────────────────────────────────────────────────────
    if (activeDemo.cancelled) throw new Error('Demo cancelled');

    const declineSeries = [
      { heartRate: 85, spo2: 96, bpSystolic: 118, bpDiastolic: 76, respiratoryRate: 19, temperature: 37.1 },
      { heartRate: 96, spo2: 93, bpSystolic: 112, bpDiastolic: 72, respiratoryRate: 22, temperature: 37.5 },
      { heartRate: 108, spo2: 90, bpSystolic: 105, bpDiastolic: 68, respiratoryRate: 25, temperature: 37.8 },
    ];

    let lastDeclineReading = null;
    for (let i = 0; i < declineSeries.length; i += 1) {
      const reading = declineSeries[i];
      const rTime = new Date(Date.now() + (i + 1) * 2000);
      lastDeclineReading = {
        ...reading,
        readingId: `demo-decline-${i}-${Date.now()}`,
        deviceId: 'BED-SIM-01',
        deviceTimestamp: rTime.toISOString(),
        source: 'simulation',
      };
      await vitalsIngestionService.ingestVitals({
        patient,
        payload: lastDeclineReading,
        io,
        actor: caregiverUser,
      });
    }

    // Add structured caregiver note with symptom flags
    const noteText = 'Patient feels dizzy and short of breath after sitting up. Appetite reduced and mild confusion noted.';
    const noteRes = await careService.addCareNote({
      patient,
      user: caregiverUser,
      text: noteText,
      io,
    });

    emitStep({
      step: 2,
      phase: 'slow_decline',
      title: 'Phase 2: Gradual Decline & Caregiver Note',
      description: `SpO2 falling to 90%, HR rising to 108 bpm. Caregiver note flags dizziness, breathlessness, and confusion.`,
      vitals: lastDeclineReading,
      noteText,
      extractedFlags: noteRes?.note?.flags || ['dizziness', 'breathing_difficulty', 'confusion'],
    });

    await sleep(stepDelayMs);

    // ──────────────────────────────────────────────────────────────────────────
    // Phase 3: 24–48h Deterioration Predicted & Alert Dispatched
    // ──────────────────────────────────────────────────────────────────────────
    if (activeDemo.cancelled) throw new Error('Demo cancelled');

    const trendResult = await trendPredictionService.assessAndSyncPatientTrend({ patient, io, actor: caregiverUser });
    const trendPrediction = trendResult?.prediction || {};

    // Fetch the generated deterioration alert
    const deteriorationAlert = await Alert.findOne({
      patient: patient._id,
      type: 'deterioration_risk',
      status: { $in: ['active', 'investigating', 'escalated'] },
    }).sort({ createdAt: -1 });

    emitStep({
      step: 3,
      phase: 'trend_predicted',
      title: 'Phase 3: 24–48h Deterioration Risk Predicted',
      description: `Predictive model flagged HIGH risk (${Math.round((trendPrediction.riskScore || 0.88) * 100)}%). Multi-factor explanation combines vitals slope with note symptoms. Alert dispatched to caregiver.`,
      riskScore: trendPrediction.riskScore,
      riskLevel: trendPrediction.riskLevel,
      factors: trendPrediction.topContributingFactors || [],
      alertId: deteriorationAlert?._id || null,
    });

    await sleep(stepDelayMs);

    // ──────────────────────────────────────────────────────────────────────────
    // Phase 4: Alert Unacknowledged → Automatic Escalation
    // ──────────────────────────────────────────────────────────────────────────
    if (activeDemo.cancelled) throw new Error('Demo cancelled');

    // Simulate timeout expiration on the active alert
    if (deteriorationAlert) {
      // Set creation date back by 400 seconds so timeout elapses
      deteriorationAlert.createdAt = new Date(Date.now() - 400 * 1000);
      await deteriorationAlert.save();
    }

    // Execute escalation cycle
    const escalated = await runEscalationCycle(io, Date.now());
    const updatedAlert = deteriorationAlert ? await Alert.findById(deteriorationAlert._id) : null;

    emitStep({
      step: 4,
      phase: 'escalation',
      title: 'Phase 4: ACK Timeout & Clinical Escalation',
      description: `Caregiver did not acknowledge alert in time. Monitor automatically escalated alert to Doctor ${doctorUser.name} (Escalation Level ${updatedAlert?.escalationLevel || 1}).`,
      escalationLevel: updatedAlert?.escalationLevel || 1,
      alertId: updatedAlert?._id || null,
      escalatedCount: escalated.length,
    });

    await sleep(stepDelayMs);

    // ──────────────────────────────────────────────────────────────────────────
    // Phase 5: Caregiver / Doctor ACK & Clinical Intervention
    // ──────────────────────────────────────────────────────────────────────────
    if (activeDemo.cancelled) throw new Error('Demo cancelled');

    if (updatedAlert) {
      updatedAlert.isAcknowledged = true;
      updatedAlert.acknowledgedBy = doctorUser._id;
      updatedAlert.acknowledgedAt = new Date();
      updatedAlert.status = 'investigating';
      await updatedAlert.save();

      await recordAudit({
        action: 'alert_acknowledged',
        entityType: 'Alert',
        entityId: updatedAlert._id,
        actor: doctorUser._id,
        actorRole: doctorUser.role,
        metadata: { demoStep: 5, escalationLevel: updatedAlert.escalationLevel },
      });

      if (io) {
        io.emit('alert:acknowledged', {
          alertId: updatedAlert._id,
          acknowledgedBy: doctorUser._id,
          acknowledgedAt: updatedAlert.acknowledgedAt,
        });
      }
    }

    // Caregiver logs clinical response note
    const actionNoteText = 'Doctor reviewed bedside alert. Administered supplemental oxygen 2L/min nasal cannula. Patient positioned in Fowler position.';
    await careService.addCareNote({
      patient,
      user: caregiverUser,
      text: actionNoteText,
      io,
    });

    emitStep({
      step: 5,
      phase: 'caregiver_ack',
      title: 'Phase 5: Alert Acknowledgment & Caregiver Action',
      description: `Doctor ${doctorUser.name} acknowledged alert. Caregiver administered 2L O2 and Fowler positioning. Intervention recorded.`,
      acknowledged: true,
      actionNote: actionNoteText,
    });

    await sleep(stepDelayMs);

    // ──────────────────────────────────────────────────────────────────────────
    // Phase 6: Physiological Recovery & Loop Closure
    // ──────────────────────────────────────────────────────────────────────────
    if (activeDemo.cancelled) throw new Error('Demo cancelled');

    const recoverySeries = [
      { heartRate: 86, spo2: 95, bpSystolic: 116, bpDiastolic: 74, respiratoryRate: 18, temperature: 37.0 },
      { heartRate: 74, spo2: 98, bpSystolic: 120, bpDiastolic: 80, respiratoryRate: 16, temperature: 36.7 },
    ];

    let finalReading = null;
    for (let i = 0; i < recoverySeries.length; i += 1) {
      const reading = recoverySeries[i];
      const rTime = new Date(Date.now() + (i + 1) * 2000);
      finalReading = {
        ...reading,
        readingId: `demo-recovery-${i}-${Date.now()}`,
        deviceId: 'BED-SIM-01',
        deviceTimestamp: rTime.toISOString(),
        source: 'simulation',
      };
      await vitalsIngestionService.ingestVitals({
        patient,
        payload: finalReading,
        io,
        actor: caregiverUser,
      });
    }

    // Re-evaluate trend after recovery vitals
    const recoveryResult = await trendPredictionService.assessAndSyncPatientTrend({ patient, io });
    const recoveryTrend = recoveryResult?.prediction;

    // Auto-resolve any remaining alerts
    await Alert.updateMany(
      { patient: patient._id, status: { $in: ['active', 'investigating', 'escalated'] } },
      { $set: { status: 'resolved', resolvedAt: new Date(), resolutionNotes: 'Vitals normalized during demo story' } }
    );

    const summary = {
      completedAt: new Date().toISOString(),
      patient: { id: patient._id, code: patient.patientId, name: patient.name },
      phasesCompleted: 6,
      finalRiskLevel: recoveryTrend?.riskLevel || 'low',
      missionLoop: 'Sense → Understand → Predict → Alert → Respond',
      success: true,
    };

    emitStep({
      step: 6,
      phase: 'recovery',
      title: 'Phase 6: Physiological Recovery & Loop Closure',
      description: `Patient vitals normalized (SpO2 98%, HR 74). Trend risk returned to Low. Alerts resolved. Full loop complete: Sense → Understand → Predict → Alert → Respond.`,
      vitals: finalReading,
      riskLevel: recoveryTrend?.riskLevel || 'low',
      summary,
    });

    activeDemo.isRunning = false;
    activeDemo.summary = summary;

    if (io) {
      io.emit('demo:completed', summary);
    }

    return summary;
  } catch (error) {
    activeDemo.isRunning = false;
    activeDemo.error = error.message;
    if (io) {
      io.emit('demo:error', { error: error.message, step: activeDemo.step });
    }
    throw error;
  }
};

module.exports = {
  runDemoStory,
  getDemoStatus,
  cancelDemo,
};
