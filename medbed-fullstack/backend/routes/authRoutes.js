// backend/routes/authRoutes.js
const express = require('express');
const { body } = require('express-validator');
const { signup, login, getMe, logout, updatePassword } = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const { loginRateLimit } = require('../middleware/loginRateLimit');

const router = express.Router();

const signupRules = [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('role')
    .optional()
    .isIn(['doctor', 'nurse'])
    .withMessage('Public signup supports doctor or nurse roles only'),
  body('department').optional().isString().trim().isLength({ max: 120 }),
];
const loginRules = [
  body('email').isEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password is required'),
];
const passwordRules = [
  body('currentPassword').notEmpty().withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 8 })
    .withMessage('New password must be at least 8 characters'),
];

router.post('/signup', signupRules, signup);
router.post('/login', loginRateLimit, loginRules, login);
router.get('/me', protect, getMe);
router.post('/logout', protect, logout);
router.patch('/update-password', protect, passwordRules, updatePassword);

module.exports = router;
