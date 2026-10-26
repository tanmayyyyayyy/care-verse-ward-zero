// backend/middleware/auth.js
// JWT verification + role-based access control

const jwt  = require('jsonwebtoken');
const User = require('../models/User');

// ── protect ─────────────────────────────────────────────────────────────────
// Verifies the Bearer token in the Authorization header.
// Attaches req.user for downstream controllers.
const protect = async (req, res, next) => {
  try {
    let token;

    // Accept token from Authorization header OR cookie
    if (req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies?.token) {
      token = req.cookies.token;
    }

    if (!token) {
      return res.status(401).json({ success: false, message: 'Not authenticated. Please log in.' });
    }

    // Verify signature + expiry
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch user (will catch deactivated accounts)
    const user = await User.findById(decoded.id).select('-password');
    if (!user || !user.isActive) {
      return res.status(401).json({ success: false, message: 'User no longer exists or is deactivated.' });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ success: false, message: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ success: false, message: 'Invalid token.' });
  }
};

// ── authorize ────────────────────────────────────────────────────────────────
// Usage: router.delete('/...', protect, authorize('admin'), handler)
// Accepts one or more role strings.
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Required role(s): ${roles.join(', ')}. Your role: ${req.user.role}.`,
      });
    }
    next();
  };
};

module.exports = { protect, authorize };
