// backend/routes/alertRoutes.js

const express = require('express');
const {
  getAllAlerts, acknowledgeAlert, dismissAlert, getAlertSummary,
} = require('../controllers/alertController');
const { protect } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

router.get('/',          getAllAlerts);
router.get('/summary',   getAlertSummary);
router.patch('/:id/acknowledge', acknowledgeAlert);
router.patch('/:id/dismiss',     dismissAlert);

module.exports = router;

// ─────────────────────────────────────────────────────────────────────────────
// backend/routes/hospitalRoutes.js
// Simple CRUD for hospital registry (inter-hospital transfers)
