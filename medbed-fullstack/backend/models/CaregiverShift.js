// backend/models/CaregiverShift.js
// Caregiver attendance: one document per check-in/check-out period.
// lastActivityAt is refreshed whenever the caregiver acknowledges/dismisses an
// alert or writes a note, which lets the platform tell "present" from "idle".

const mongoose = require('mongoose');

const caregiverShiftSchema = new mongoose.Schema(
  {
    caregiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    userName: { type: String, default: '' },
    role: { type: String, default: '' },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', index: true },
    patients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Patient' }],
    checkInAt: { type: Date, default: Date.now },
    checkOutAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ['on_duty', 'off_duty', 'missed'],
      default: 'on_duty',
      index: true,
    },
    notes: { type: String, default: '' },
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

// Keep caregiver and user fields synchronized
caregiverShiftSchema.pre('validate', function (next) {
  if (this.caregiver && !this.user) this.user = this.caregiver;
  if (this.user && !this.caregiver) this.caregiver = this.user;
  if (this.patient && (!this.patients || !this.patients.length)) {
    this.patients = [this.patient];
  } else if (this.patients && this.patients.length && !this.patient) {
    this.patient = this.patients[0];
  }
  next();
});

caregiverShiftSchema.index({ caregiver: 1, status: 1 });
caregiverShiftSchema.index({ user: 1, checkOutAt: 1 });
caregiverShiftSchema.index({ checkOutAt: 1, checkInAt: -1 });

module.exports = mongoose.model('CaregiverShift', caregiverShiftSchema);
