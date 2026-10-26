// backend/controllers/authController.js
// Handles registration, login, profile fetch, and logout

const jwt         = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const User        = require('../models/User');
const { AppError } = require('../middleware/errorHandler');

// ── Helper: sign and return JWT ─────────────────────────────────────────────
const signToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

const sendTokenResponse = (user, statusCode, res) => {
  const token = signToken(user._id);

  res.status(statusCode).json({
    success: true,
    token,
    user: user.toPublicJSON(),
  });
};

// ── POST /api/auth/signup ────────────────────────────────────────────────────
exports.signup = async (req, res, next) => {
  try {
    // Validate incoming fields
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { name, email, password, role, department } = req.body;

    // Check for existing user
    const exists = await User.findOne({ email });
    if (exists) {
      return next(new AppError('An account with this email already exists.', 409));
    }

    // Create user (password hashed via pre-save hook)
    const user = await User.create({ name, email, password, role, department });

    sendTokenResponse(user, 201, res);
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/login ─────────────────────────────────────────────────────
exports.login = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { email, password } = req.body;

    // Fetch user with password (select: false by default)
    const user = await User.findOne({ email }).select('+password');
    if (!user || !user.isActive) {
      return next(new AppError('Invalid email or password.', 401));
    }

    // Compare password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return next(new AppError('Invalid email or password.', 401));
    }

    // Record last login
    user.lastLogin = new Date();
    await user.save({ validateBeforeSave: false });

    sendTokenResponse(user, 200, res);
  } catch (error) {
    next(error);
  }
};

// ── GET /api/auth/me ─────────────────────────────────────────────────────────
// Protected — returns current user profile
exports.getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    res.status(200).json({ success: true, user: user.toPublicJSON() });
  } catch (error) {
    next(error);
  }
};

// ── POST /api/auth/logout ────────────────────────────────────────────────────
// JWT is stateless; client must delete the token.
// We just confirm to the client that logout is complete.
exports.logout = (req, res) => {
  res.status(200).json({ success: true, message: 'Logged out successfully.' });
};

// ── PATCH /api/auth/update-password ─────────────────────────────────────────
exports.updatePassword = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select('+password');
    if (!user) return next(new AppError('User not found.', 404));

    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) return next(new AppError('Current password is incorrect.', 401));

    user.password = newPassword;
    await user.save();

    sendTokenResponse(user, 200, res);
  } catch (error) {
    next(error);
  }
};
