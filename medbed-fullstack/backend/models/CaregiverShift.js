// backend/models/CaregiverShift.js
// Caregiver attendance: one document per check-in/check-out period.
// lastActivityAt is refreshed whenever the caregiver acknowledges/dismisses an
// alert or writes a note, which lets the platform tell "present" from "idle".

const mongoose = require('mongoose');

const caregiverShiftSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userName: { type: String, default: '' },
    role: { type: String, default: '' },
    patients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Patient' }],
    checkInAt: { type: Date, default: Date.now },
    checkOutAt: { type: Date, default: null },
    lastActivityAt: { type: Date, default: Date.now },
    activity: {
      acknowledged: { type: Number, default: 0 },
      dismissed: { type: Number, default: 0 },
      notes: { type: Number, default: 0 },
    },
    autoClosed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

caregiverShiftSchema.index({ user: 1, checkOutAt: 1 });
caregiverShiftSchema.index({ checkOutAt: 1, checkInAt: -1 });

module.exports = mongoose.model('CaregiverShift', caregiverShiftSchema);
