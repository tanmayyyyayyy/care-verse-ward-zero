// backend/routes/hospitalRoutes.js

const express  = require('express');
const { Hospital } = require('../models/index');
const { protect, authorize } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');

const router = express.Router();
router.use(protect);

// GET all hospitals
router.get('/', async (req, res, next) => {
  try {
    const hospitals = await Hospital.find({ isActive: true }).sort({ name: 1 });
    res.status(200).json({ success: true, count: hospitals.length, data: hospitals });
  } catch (e) { next(e); }
});

// POST create hospital — admin only
router.post('/', authorize('admin'), async (req, res, next) => {
  try {
    const hospital = await Hospital.create(req.body);
    res.status(201).json({ success: true, data: hospital });
  } catch (e) { next(e); }
});

// PATCH update
router.patch('/:id', authorize('admin'), async (req, res, next) => {
  try {
    const hospital = await Hospital.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!hospital) return next(new AppError('Hospital not found.', 404));
    res.status(200).json({ success: true, data: hospital });
  } catch (e) { next(e); }
});

// DELETE (soft)
router.delete('/:id', authorize('admin'), async (req, res, next) => {
  try {
    await Hospital.findByIdAndUpdate(req.params.id, { isActive: false });
    res.status(200).json({ success: true, message: 'Hospital removed.' });
  } catch (e) { next(e); }
});

module.exports = router;
