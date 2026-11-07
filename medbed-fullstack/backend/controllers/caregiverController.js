'use strict';

const caregiverService = require('../services/caregiverService');
const { resolveAlertsByType } = require('../services/alertService');
const { recordAudit } = require('../services/auditService');

exports.checkIn = async (req, res, next) => {
  try {
    const rawPatient = req.body.patient || req.body.patientId;
    const rawPatients = req.body.patients;
    let patientIds = [];
    if (Array.isArray(rawPatients) && rawPatients.length) {
      patientIds = rawPatients;
    } else if (rawPatient) {
      patientIds = [rawPatient];
    }

    const notes = String(req.body.notes || '').trim();
    const { shift } = await caregiverService.checkIn(req.user, patientIds, notes);
    const io = req.app.get('io');

    if (patientIds.length && io) {
      for (const pid of patientIds) {
        await resolveAlertsByType(pid, ['caregiver_missed_checkin'], io, 'Caregiver checked in on duty.');
      }
    }

    if (io) {
      io.emit('caregiver:checkin', {
        caregiver: {
          id: req.user._id,
          name: req.user.name,
          role: req.user.role,
          department: req.user.department,
        },
        shift,
        timestamp: new Date().toISOString(),
      });
    }

    await recordAudit({
      actor: req.user._id,
      role: req.user.role,
      action: 'caregiver_checkin',
      entityType: 'CaregiverShift',
      entityId: shift._id,
      patient: patientIds[0] || null,
      metadata: { patientIds, notes },
    });

    res.status(200).json({ success: true, data: shift });
  } catch (error) {
    next(error);
  }
};

exports.checkOut = async (req, res, next) => {
  try {
    const notes = String(req.body.notes || '').trim();
    const shift = await caregiverService.checkOut(req.user, notes);
    if (!shift) {
      return res.status(400).json({ success: false, message: 'No active on-duty shift found to check out.' });
    }

    const io = req.app.get('io');
    if (io) {
      io.emit('caregiver:checkout', {
        caregiver: {
          id: req.user._id,
          name: req.user.name,
          role: req.user.role,
        },
        shift,
        timestamp: new Date().toISOString(),
      });
    }

    await recordAudit({
      actor: req.user._id,
      role: req.user.role,
      action: 'caregiver_checkout',
      entityType: 'CaregiverShift',
      entityId: shift._id,
      metadata: { notes, durationHours: (new Date(shift.checkOutAt) - new Date(shift.checkInAt)) / 3600000 },
    });

    res.status(200).json({ success: true, data: shift });
  } catch (error) {
    next(error);
  }
};

exports.getOnDuty = async (req, res, next) => {
  try {
    const shifts = await caregiverService.getOnDutyShifts();
    res.status(200).json({ success: true, count: shifts.length, data: shifts });
  } catch (error) {
    next(error);
  }
};

exports.getPerformance = async (req, res, next) => {
  try {
    const sinceHours = req.query.sinceHours ? Number(req.query.sinceHours) : 24;
    const performance = await caregiverService.getCaregiverPerformance({ sinceHours });
    res.status(200).json({ success: true, data: performance });
  } catch (error) {
    next(error);
  }
};

