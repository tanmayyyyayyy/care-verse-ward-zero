const express = require('express');
const { body, param } = require('express-validator');
const care = require('../controllers/careController');
const { protect, authorize } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();
router.use(protect);

const patientParam = param('id').isMongoId().withMessage('Invalid patient id');

// Contextual intelligence + forecast
router.get('/overview', care.getOverview);
router.get('/patients/:id/intelligence', patientParam, validate, care.getIntelligence);
router.get('/patients/:id/notes', patientParam, validate, care.listNotes);
router.post(
  '/patients/:id/notes',
  patientParam,
  body('text').isString().trim().isLength({ min: 3, max: 1000 }).withMessage('Note must be 3-1000 characters'),
  validate,
  care.addNote
);

// Caregiver attendance / responsiveness
router.get('/roster', care.getRoster);
router.post('/check-in', body('patients').optional().isArray(), validate, care.checkIn);
router.post('/check-out', care.checkOut);

// Home gateway (sensor link) — resilience demonstration
router.get('/gateway', care.getGateway);
router.post(
  '/gateway/connectivity',
  authorize('admin', 'doctor'),
  body('online').isBoolean().withMessage('online must be true or false'),
  validate,
  care.setConnectivity
);
router.post(
  '/gateway/emit',
  authorize('admin', 'doctor'),
  body('patientId').isMongoId(),
  body('scenario').isIn(['stable', 'slow_decline', 'sudden_drop']),
  body('steps').optional().isInt({ min: 1, max: 10 }).toInt(),
  validate,
  care.emitViaGateway
);
router.post('/gateway/reset', authorize('admin', 'doctor'), care.resetGateway);

module.exports = router;
