// backend/controllers/transferController.js
// Transfer lifecycle: create → approve/reject → in_transit → completed

const Transfer    = require('../models/Transfer');
const { Approval, Alert } = require('../models/index');
const Patient     = require('../models/Patient');
const { AppError } = require('../middleware/errorHandler');

// ── GET /api/transfers ───────────────────────────────────────────────────────
exports.getAllTransfers = async (req, res, next) => {
  try {
    const { status, patient } = req.query;
    const filter = {};
    if (status)  filter.status  = status;
    if (patient) filter.patient = patient;

    const transfers = await Transfer.find(filter)
      .populate('patient',         'name patientId ward bed condition riskLevel')
      .populate('assignedNurse',   'name email')
      .populate('destinationHospital', 'name city')
      .sort({ createdAt: -1 });

    res.status(200).json({ success: true, count: transfers.length, data: transfers });
  } catch (error) {
    next(error);
  }
};

// ── GET /api/transfers/:id ───────────────────────────────────────────────────
exports.getTransfer = async (req, res, next) => {
  try {
    const transfer = await Transfer.findById(req.params.id)
      .populate('patient assignedNurse destinationHospital');
    if (!transfer) return next(new AppError('Transfer not found.', 404));
    res.status(200).json({ success: true, data: transfer });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/transfers ──────────────────────────────────────────────────────
exports.createTransfer = async (req, res, next) => {
  try {
    const patient = await Patient.findById(req.body.patient);
    if (!patient) return next(new AppError('Patient not found.', 404));

    const transfer = await Transfer.create({
      ...req.body,
      status: 'pending_approval',
    });

    // Create an alert for pending approval
    await Alert.create({
      patient:  patient._id,
      transfer: transfer._id,
      type:     'other',
      severity: 'info',
      message:  `Transfer request for ${patient.name} (${patient.patientId}) awaiting management approval.`,
    });

    const io = req.app.get('io');
    if (io) io.emit('transfer:created', { transfer });

    res.status(201).json({ success: true, data: transfer });
  } catch (error) {
    next(error);
  }
};

// ── PATCH /api/transfers/:id ─────────────────────────────────────────────────
exports.updateTransfer = async (req, res, next) => {
  try {
    const transfer = await Transfer.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    }).populate('patient assignedNurse');

    if (!transfer) return next(new AppError('Transfer not found.', 404));

    const io = req.app.get('io');
    if (io) io.emit('transfer:updated', { transfer });

    res.status(200).json({ success: true, data: transfer });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/transfers/:id/approve ─────────────────────────────────────────
// Admin or Doctor only
exports.approveTransfer = async (req, res, next) => {
  try {
    const { decision, remarks } = req.body; // 'approved' | 'rejected'

    if (!['approved', 'rejected'].includes(decision)) {
      return next(new AppError('Decision must be "approved" or "rejected".', 400));
    }

    const transfer = await Transfer.findById(req.params.id).populate('patient');
    if (!transfer) return next(new AppError('Transfer not found.', 404));

    if (transfer.status !== 'pending_approval') {
      return next(new AppError(`Transfer is already ${transfer.status}.`, 400));
    }

    // Record approval
    const approval = await Approval.create({
      transfer:   transfer._id,
      reviewedBy: req.user._id,
      decision,
      remarks:    remarks || '',
    });

    // Update transfer status
    transfer.status = decision; // 'approved' or 'rejected'
    if (decision === 'approved') transfer.scheduledAt = transfer.scheduledAt || new Date();
    await transfer.save();

    const io = req.app.get('io');
    if (io) {
      io.emit('transfer:approval', {
        transferId: transfer._id,
        decision,
        reviewedBy: req.user.name,
      });
    }

    res.status(200).json({ success: true, data: { transfer, approval } });
  } catch (error) {
    next(error);
  }
};

// ── PATCH /api/transfers/:id/progress ────────────────────────────────────────
// Nurse updates real-time progress
exports.updateProgress = async (req, res, next) => {
  try {
    const { progressPercent, status } = req.body;
    const transfer = await Transfer.findById(req.params.id);
    if (!transfer) return next(new AppError('Transfer not found.', 404));

    if (progressPercent !== undefined) transfer.progressPercent = progressPercent;
    if (status) {
      transfer.status = status;
      if (status === 'in_transit' && !transfer.startedAt)    transfer.startedAt    = new Date();
      if (status === 'completed'  && !transfer.completedAt)  transfer.completedAt  = new Date();
    }
    await transfer.save();

    const io = req.app.get('io');
    if (io) {
      io.emit('transfer:progress', {
        transferId:      transfer._id,
        progressPercent: transfer.progressPercent,
        status:          transfer.status,
      });
    }

    res.status(200).json({ success: true, data: transfer });
  } catch (error) {
    next(error);
  }
};
