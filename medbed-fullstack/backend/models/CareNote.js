// backend/models/CareNote.js
// Free-text caregiver observations attached to a patient. Notes feed the
// contextual-intelligence layer (see services/noteContext.js).

const mongoose = require('mongoose');

const careNoteSchema = new mongoose.Schema(
  {
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
      index: true,
    },
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, default: '' },
    authorRole: { type: String, default: '' },
    text: { type: String, required: true, trim: true, maxlength: 1000 },
    // Context flags extracted at write time (kept for audit/explainability)
    flags: {
      type: [
        {
          id: String,
          label: String,
          level: String,
          phrase: String,
        },
      ],
      default: [],
    },
  },
  { timestamps: true }
);

careNoteSchema.index({ patient: 1, createdAt: -1 });

module.exports = mongoose.model('CareNote', careNoteSchema);
