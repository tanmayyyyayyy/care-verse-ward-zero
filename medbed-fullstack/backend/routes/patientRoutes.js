const express = require('express');
const { body } = require('express-validator');
const {
  getAllPatients, getPatient, createPatient,
  updatePatient, deletePatient, recordVitals, getVitals,
} = require('../controllers/patientController');
const { runScenario } = require('../controllers/simulationController');
const { protect, authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();
router.use(protect);

const conditions = ['general', 'cardiac', 'hydrocephalus', 'icu', 'orthopaedic', 'respiratory'];
const patientRules = (isUpdate = false) => {
  const rule = (field) => (isUpdate ? body(field).optional() : body(field));
  return [
    body('patientId').optional().isString().trim().isLength({ min: 1, max: 40 }),
    rule('name').isString().trim().isLength({ min: 1, max: 120 }),
    rule('age').isInt({ min: 0, max: 130 }).toInt(),
    rule('gender').isIn(['male', 'female', 'other']),
    rule('ward').isString().trim().isLength({ min: 1, max: 80 }),
    rule('bed').isString().trim().isLength({ min: 1, max: 40 }),
    rule('condition').optional().isIn(conditions),
    rule('diagnosis').optional().isString().trim().isLength({ max: 500 }),
    rule('isPostSurgery').optional().isBoolean().toBoolean(),
    rule('assignedDoctor').optional({ nullable: true }).isMongoId(),
    rule('notes').optional().isString().trim().isLength({ max: 2000 }),
  ];
};

const vitalsRules = [
  body('readingId').optional().isString().trim().isLength({ min: 1, max: 120 }),
  body('deviceId').optional().isString().trim().isLength({ min: 1, max: 120 }),
  body('heartRate').isFloat({ min: 20, max: 300 }).toFloat(),
  body('spo2').isFloat({ min: 50, max: 100 }).toFloat(),
  body('bpSystolic').isFloat({ min: 40, max: 300 }).toFloat(),
  body('bpDiastolic').isFloat({ min: 20, max: 200 }).toFloat(),
  body('temperature').optional().isFloat({ min: 30, max: 45 }).toFloat(),
  body('respiratoryRate').optional().isFloat({ min: 4, max: 80 }).toFloat(),
  body('deviceTimestamp').optional({ nullable: true }).isISO8601(),
  body('source').optional().isIn(['manual', 'sensor', 'simulation']),
  body('bpSystolic').custom((value, { req }) => {
    const systolic = Number(value);
    const diastolic = Number(req.body.bpDiastolic);
    if (Number.isFinite(systolic) && Number.isFinite(diastolic) && systolic <= diastolic) {
      throw new Error('Systolic blood pressure must be greater than diastolic.');
    }
    return true;
  }),
];

router.route('/')
  .get(getAllPatients)
  .post(
    authorize('admin', 'doctor'),
    patientRules(false),
    validate,
    createPatient
  );

router.route('/:id')
  .get(getPatient)
  .patch(
    authorize('admin', 'doctor'),
    patientRules(true),
    validate,
    updatePatient
  )
  .delete(authorize('admin'), deletePatient);

router.route('/:id/vitals')
  .get(getVitals)
  .post(vitalsRules, validate, recordVitals);

router.post(
  '/:id/simulate',
  body('scenario').isIn(['stable', 'slow_decline', 'sudden_drop']),
  body('steps').optional().isInt({ min: 1, max: 20 }).toInt(),
  validate,
  runScenario
);

module.exports = router;
