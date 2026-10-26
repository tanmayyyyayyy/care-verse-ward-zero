// backend/routes/mlRoutes.js
// Exposes the 3-model medbed-ml prediction system via REST API

const express = require('express');
const router = express.Router();
const ml = require('../services/mlPredictionService');
const Patient = require('../models/Patient');
const Vitals = require('../models/Vitals');
const { protect } = require('../middleware/auth');

// ── GET /api/ml/health ────────────────────────────────────────────────────────
router.get('/health', async (req, res) => {
  const health = await ml.checkHealth();
  res.status(health.ok ? 200 : 503).json({
    success: health.ok,
    service: 'medbed-ml',
    ...health,
  });
});

// ── POST /api/ml/predict/transfer ─────────────────────────────────────────────
router.post('/predict/transfer', async (req, res, next) => {
  try {
    const result = await ml.predictTransfer(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/ml/predict/vitals ───────────────────────────────────────────────
router.post('/predict/vitals', async (req, res, next) => {
  try {
    const result = await ml.predictVitals(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/ml/predict/safety ───────────────────────────────────────────────
router.post('/predict/safety', async (req, res, next) => {
  try {
    const result = await ml.predictSafety(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/ml/predict/all ──────────────────────────────────────────────────
router.post('/predict/all', async (req, res, next) => {
  try {
    const result = await ml.predictAll(req.body);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/ml/patients/:id/assess-transfer ─────────────────────────────────
// Context-aware transfer prediction: automatically extracts patient's latest vitals & condition
router.post('/patients/:id/assess-transfer', protect, async (req, res, next) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient) {
      return res.status(404).json({ success: false, message: 'Patient not found' });
    }

    const latestVitals = await Vitals.findOne({ patient: patient._id }).sort({
      observedAt: -1,
      recordedAt: -1,
    });

    const conditionMap = {
      General: 0,
      Cardiac: 1,
      Respiratory: 2,
      Neuro: 3,
      ICU: 4,
    };

    const payload = {
      age: patient.age || 60,
      weight_kg: req.body.weight_kg || 70,
      condition: conditionMap[patient.condition] ?? 0,
      department_from: req.body.department_from ?? 0,
      department_to: req.body.department_to ?? 1,
      heart_rate: latestVitals ? latestVitals.heartRate : 80,
      spo2: latestVitals ? latestVitals.spo2 : 98,
      bp_systolic: latestVitals ? latestVitals.bpSystolic : 120,
      bp_diastolic: latestVitals ? latestVitals.bpDiastolic : 80,
      transfer_distance: req.body.transfer_distance || 150.0,
      time_of_day: new Date().getHours(),
      is_post_surgery: req.body.is_post_surgery ? 1 : 0,
      equipment_count: req.body.equipment_count || 1,
    };

    const prediction = await ml.predictTransfer(payload);
    res.status(200).json({
      success: true,
      patient: { id: patient._id, name: patient.name, patientId: patient.patientId },
      input: payload,
      prediction,
      recommendation:
        prediction.risk_level === 2
          ? 'delay_transfer'
          : prediction.risk_level === 1
          ? 'proceed_with_caution'
          : 'proceed',
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
