// backend/routes/transferRoutes.js

const express = require('express');
const {
  getAllTransfers, getTransfer, createTransfer,
  updateTransfer, approveTransfer, updateProgress,
} = require('../controllers/transferController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();
router.use(protect);

router.route('/')
  .get(getAllTransfers)
  .post(createTransfer);

router.route('/:id')
  .get(getTransfer)
  .patch(authorize('admin', 'doctor'), updateTransfer);

// Management approval — admin + doctor only
router.post('/:id/approve', authorize('admin', 'doctor'), approveTransfer);

// Nurses update live progress
router.patch('/:id/progress', updateProgress);

module.exports = router;
