// backend/models/User.js
// Mongoose schema for hospital staff (Admin / Doctor / Nurse)

const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      maxlength: [80, 'Name cannot exceed 80 characters'],
    },

    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email'],
    },

    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters'],
      select: false, // Never return password in queries by default
    },

    role: {
      type: String,
      enum: ['admin', 'doctor', 'nurse'],
      default: 'nurse',
    },

    department: {
      type: String,
      default: 'General',
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    lastLogin: {
      type: Date,
    },
  },
  {
    timestamps: true, // adds createdAt + updatedAt automatically
  }
);

// ── PRE-SAVE HOOK: Hash password before saving ──────────────────────────────
userSchema.pre('save', async function (next) {
  // Only hash if password field was actually modified
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(12);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// ── INSTANCE METHOD: Compare plain password vs stored hash ─────────────────
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// ── INSTANCE METHOD: Safe public profile (no password) ─────────────────────
userSchema.methods.toPublicJSON = function () {
  return {
    id:         this._id,
    name:       this.name,
    email:      this.email,
    role:       this.role,
    department: this.department,
    isActive:   this.isActive,
    lastLogin:  this.lastLogin,
    createdAt:  this.createdAt,
  };
};

module.exports = mongoose.model('User', userSchema);
