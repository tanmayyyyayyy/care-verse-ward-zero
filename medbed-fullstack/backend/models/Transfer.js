// backend/models/Transfer.js
// Represents a single patient transfer request lifecycle

const mongoose = require('mongoose');

const transferSchema = new mongoose.Schema(
  {
    transferId: { type: String, unique: true },

    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
    },

    // Locations
    fromWard: { type: String, required: true },
    toWard:   { type: String, required: true },

    // Inter-hospital extension
    isInterHospital: { type: Boolean, default: false },
    destinationHospital: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Hospital',
      default: null,
    },
    ambulanceRequired: { type: Boolean, default: false },

    // Documents checklist stored as key-value flags
    documents: {
      medicalSummary:      { type: Boolean, default: false },
      consentForm:         { type: Boolean, default: false },
      labReports:          { type: Boolean, default: false },
      imagingReports:      { type: Boolean, default: false },
      insuranceAuth:       { type: Boolean, default: false },
    },

    // Lifecycle status
    status: {
      type: String,
      enum: ['pending_approval', 'approved', 'rejected', 'in_transit', 'completed', 'cancelled'],
      default: 'pending_approval',
    },

    // Progress percentage (0–100), updated by socket events
    progressPercent: { type: Number, default: 0 },

    // Optimized route suggested by AI
    suggestedRoute: { type: String, default: '' },

    // Staff
    assignedNurse: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    // Timing
    scheduledAt:   { type: Date },
    startedAt:     { type: Date },
    completedAt:   { type: Date },
    estimatedETA:  { type: Date },

    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

transferSchema.pre('save', async function (next) {
  if (!this.transferId) {
    const count = await mongoose.model('Transfer').countDocuments();
    this.transferId = `TR-${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Transfer', transferSchema);
