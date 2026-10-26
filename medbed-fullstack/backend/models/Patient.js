// backend/models/Patient.js
// Core patient record schema

const mongoose = require('mongoose');

const patientSchema = new mongoose.Schema(
  {
    patientId: {
      type: String,
      unique: true,
      // Auto-generated in pre-save if not provided
    },

    name: {
      type: String,
      required: [true, 'Patient name is required'],
      trim: true,
    },

    age: { type: Number, required: true },
    gender: { type: String, enum: ['male', 'female', 'other'], required: true },

    ward: { type: String, required: true },      // e.g. "Ward 3B"
    bed:  { type: String, required: true },      // e.g. "Bed 12"

    // Medical condition category — drives AI rules
    condition: {
      type: String,
      enum: ['general', 'cardiac', 'hydrocephalus', 'icu', 'orthopaedic', 'respiratory'],
      default: 'general',
    },

    diagnosis: { type: String, default: '' },

    isPostSurgery: { type: Boolean, default: false },

    // Risk level — recomputed by AI service periodically
    riskLevel: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'low',
    },

    riskScore: { type: Number, default: 0 }, // 0–100

    assignedDoctor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    isActive: { type: Boolean, default: true },

    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

// Auto-generate human-readable patientId  (e.g. PT-2047)
patientSchema.pre('save', async function (next) {
  if (!this.patientId) {
    const count = await mongoose.model('Patient').countDocuments();
    this.patientId = `PT-${2000 + count + 1}`;
  }
  next();
});

module.exports = mongoose.model('Patient', patientSchema);
