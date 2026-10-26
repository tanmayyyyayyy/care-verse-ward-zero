// backend/models/Vitals.js
// Time-series vitals readings per patient

const crypto = require('crypto');
const mongoose = require('mongoose');

const vitalsSchema = new mongoose.Schema(
  {
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      index: true,
    },

    readingId: {
      type: String,
      required: true,
      default: () => `srv-${crypto.randomUUID()}`,
      trim: true,
    },

    deviceId: {
      type: String,
      default: 'manual',
      trim: true,
    },

    heartRate:    { type: Number, required: true },   // bpm
    spo2:         { type: Number, required: true },   // %
    bpSystolic:   { type: Number, required: true },   // mmHg
    bpDiastolic:  { type: Number, required: true },   // mmHg
    temperature:  { type: Number, default: 37.0 },    // °C
    respiratoryRate: { type: Number, default: 16 },   // breaths/min

    // AI-generated alert flags set after prediction
    aiFlags: {
      hrAlert:   { type: Boolean, default: false },
      spo2Alert: { type: Boolean, default: false },
      bpAlert:   { type: Boolean, default: false },
    },

    // Predicted risk from AI at time of this reading
    predictedRisk: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'low',
    },

    assessmentSource: {
      type: String,
      enum: ['ai', 'fallback'],
      default: 'fallback',
    },

    assessmentExplanation: {
      type: String,
      default: '',
    },

    aiRawProba: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },

    fallbackReason: {
      type: String,
      default: null,
    },

    deviceTimestamp: {
      type: Date,
      default: null,
    },

    // Canonical observation time used for latest-reading and freshness queries.
    observedAt: {
      type: Date,
      default: Date.now,
    },

    receivedAt: {
      type: Date,
      default: Date.now,
    },

    recordedAt: {
      type: Date,
      default: Date.now,
    },

    isLate: {
      type: Boolean,
      default: false,
    },

    // Who or what recorded the vitals
    source: {
      type: String,
      enum: ['manual', 'sensor', 'simulation'],
      default: 'sensor',
    },
  },
  { timestamps: false } // recordedAt handles timing
);

vitalsSchema.index(
  { patient: 1, readingId: 1 },
  { unique: true, partialFilterExpression: { readingId: { $type: 'string' } } }
);
vitalsSchema.index({ patient: 1, observedAt: -1 });
vitalsSchema.index({ patient: 1, recordedAt: -1 });
vitalsSchema.index({ recordedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

module.exports = mongoose.model('Vitals', vitalsSchema);
