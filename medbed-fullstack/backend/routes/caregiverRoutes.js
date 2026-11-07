'use strict';

const express = require('express');
const { body, query } = require('express-validator');
const caregiverController = require('../controllers/caregiverController');
const { protect } = require('../middleware/auth');
const { validate } = require('../middleware/validate');

const router = express.Router();

router.use(protect);

router.post(
  '/check-in',
  [
    body('patient').optional().isMongoId().withMessage('Invalid patient ID'),
    body('patientId').optional().isMongoId().withMessage('Invalid patient ID'),
    body('patients').optional().isArray().withMessage('patients must be an array of IDs'),
    body('notes').optional().isString().trim().isLength({ max: 500 }).withMessage('Notes cannot exceed 500 characters'),
  ],
  validate,
  caregiverController.checkIn
);

router.post(
  '/check-out',
  [
    body('notes').optional().isString().trim().isLength({ max: 500 }).withMessage('Notes cannot exceed 500 characters'),
  ],
  validate,
  caregiverController.checkOut
);

router.get('/on-duty', caregiverController.getOnDuty);

router.get(
  '/performance',
  [
    query('sinceHours').optional().isInt({ min: 1, max: 720 }).toInt().withMessage('sinceHours must be between 1 and 720'),
  ],
  validate,
  caregiverController.getPerformance
);

module.exports = router;
