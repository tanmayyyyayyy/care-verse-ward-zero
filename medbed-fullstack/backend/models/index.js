// backend/models/Approval.js
// Management approval decisions for transfer requests

const mongoose = require('mongoose');

const approvalSchema = new mongoose.Schema(
  {
    transfer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transfer',
      required: true,
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    decision: {
      type: String,
      enum: ['approved', 'rejected', 'pending'],
      default: 'pending',
    },
    remarks: { type: String, default: '' },
    reviewedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// ─────────────────────────────────────────────────────────────────────────────

// backend/models/Alert.js
const alertSchema = new mongoose.Schema(
  {
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
    },
    transfer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Transfer',
      default: null,
    },
    type: {
      type: String,
      enum: [
        'hr_high', 'spo2_low', 'bp_high', 'bp_low', 'risk_high', 'sensor_offline',
        'data_stale', 'fall_risk', 'battery_low', 'route_change',
        'checklist_incomplete', 'escalation', 'other',
      ],
      required: true,
    },
    severity: {
      type: String,
      enum: ['info', 'warning', 'critical'],
      required: true,
    },
    message:  { type: String, required: true },
    dedupKey: { type: String, default: undefined },
    sourceReadingId: { type: String, default: null },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    isAcknowledged: { type: Boolean, default: false },
    acknowledgedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    acknowledgedAt: { type: Date, default: null },
    acknowledgmentLatencyMs: { type: Number, default: null },
    acknowledgmentNote: { type: String, default: '' },
    isDismissed: { type: Boolean, default: false },
    dismissedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    dismissedAt: { type: Date, default: null },
    dismissReason: { type: String, default: '' },
    resolvedAt: { type: Date, default: null },
    resolvedReason: { type: String, default: '' },
    resolvedBySystem: { type: Boolean, default: false },
    escalationLevel: { type: Number, default: 0, min: 0, max: 2 },
    escalatedAt: { type: Date, default: null },
    escalationHistory: {
      type: [{
        level: { type: Number, required: true },
        at: { type: Date, default: Date.now },
        toRole: { type: String, default: '' },
        reason: { type: String, default: '' },
      }],
      default: [],
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

alertSchema.index(
  { dedupKey: 1 },
  { unique: true, partialFilterExpression: { dedupKey: { $type: 'string' } } }
);
alertSchema.index({ patient: 1, isAcknowledged: 1, isDismissed: 1, createdAt: -1 });
alertSchema.index({ isAcknowledged: 1, isDismissed: 1, resolvedAt: 1, createdAt: 1 });

// ─────────────────────────────────────────────────────────────────────────────

// backend/models/AuditLog.js
const auditLogSchema = new mongoose.Schema(
  {
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, default: null },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      default: null,
    },
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    actorRole: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

auditLogSchema.index({ entityType: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ patient: 1, createdAt: -1 });

// ─────────────────────────────────────────────────────────────────────────────

// backend/models/Hospital.js
const hospitalSchema = new mongoose.Schema(
  {
    name:    { type: String, required: true, unique: true },
    city:    { type: String, required: true },
    state:   { type: String, default: '' },
    phone:   { type: String, default: '' },
    email:   { type: String, default: '' },
    isActive:{ type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = {
  Approval: mongoose.model('Approval', approvalSchema),
  Alert:    mongoose.model('Alert',    alertSchema),
  Hospital: mongoose.model('Hospital', hospitalSchema),
  AuditLog: mongoose.model('AuditLog', auditLogSchema),
};
