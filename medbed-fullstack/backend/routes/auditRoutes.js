const express = require('express');
const { AuditLog } = require('../models/index');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(protect, authorize('admin', 'doctor'));

router.get('/', async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.patient) filter.patient = req.query.patient;
    if (req.query.action) filter.action = req.query.action;
    if (req.query.entityType) filter.entityType = req.query.entityType;
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(500, requestedLimit))
      : 100;

    const data = await AuditLog.find(filter)
      .populate('actor', 'name role')
      .populate('patient', 'name patientId')
      .sort({ createdAt: -1 })
      .limit(limit);

    res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
