const Patient = require('../models/Patient');
const { AppError } = require('../middleware/errorHandler');
const { ingestVitals } = require('../services/vitalsIngestionService');
const { generateScenarioReading, SCENARIOS } = require('../services/sensorSimulator');

exports.runScenario = async (req, res, next) => {
  try {
    const scenario = String(req.body.scenario || 'stable');
    if (!SCENARIOS.includes(scenario)) {
      return next(
        new AppError(`Invalid scenario. Expected one of: ${SCENARIOS.join(', ')}.`, 400)
      );
    }

    const requestedSteps = Number.parseInt(req.body.steps, 10);
    const steps = Number.isFinite(requestedSteps)
      ? Math.max(1, Math.min(20, requestedSteps))
      : 1;

    const patient = await Patient.findById(req.params.id);
    if (!patient || !patient.isActive) {
      return next(new AppError('Active patient not found.', 404));
    }

    const results = [];
    for (let index = 0; index < steps; index += 1) {
      const reading = generateScenarioReading(patient, scenario);
      const result = await ingestVitals({
        patient,
        payload: reading,
        io: req.app.get('io'),
        actor: req.user,
      });
      results.push({
        readingId: result.vitals.readingId,
        scenario,
        scenarioStep: reading.scenarioStep,
        heartRate: result.vitals.heartRate,
        spo2: result.vitals.spo2,
        bpSystolic: result.vitals.bpSystolic,
        bpDiastolic: result.vitals.bpDiastolic,
        respiratoryRate: result.vitals.respiratoryRate,
        predictedRisk: result.assessment.risk,
        assessmentSource: result.assessment.source,
        dataQuality: result.dataQuality,
        alertsCreated: result.alerts.length,
      });
    }

    res.status(201).json({
      success: true,
      patientId: patient._id,
      patientCode: patient.patientId,
      scenario,
      steps,
      data: results,
      safetyNotice:
        'Synthetic scenario data only. Rule thresholds and the experimental classifier are not clinical validation.',
    });
  } catch (error) {
    next(error);
  }
};
