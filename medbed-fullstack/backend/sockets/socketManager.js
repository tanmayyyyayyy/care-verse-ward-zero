// backend/sockets/socketManager.js
// Manages all Socket.IO real-time event handlers

const jwt  = require('jsonwebtoken');
const User = require('../models/User');

/**
 * initSockets(io)
 * Call this in server.js after creating the io instance.
 * Provides real-time channels for:
 *   - vitals:update    → live vitals pushed to dashboard
 *   - transfer:progress → nurses update progress %
 *   - alert:new        → critical alerts to all staff
 *   - transfer:approval → approval decisions broadcast
 */
const initSockets = (io) => {
  // ── JWT authentication for socket connections ──────────────────────────────
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(' ')[1];
      if (!token) return next(new Error('Authentication required'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user    = await User.findById(decoded.id).select('-password');
      if (!user)    return next(new Error('User not found'));

      socket.user = user; // attach to socket for use in handlers
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.user?.name} [${socket.user?.role}]`);

    // ── Join role-based rooms for targeted broadcasts ──────────────────────
    if (socket.user?.role) {
      socket.join(`role:${socket.user.role}`);  // e.g. 'role:doctor'
    }

    // ── Send welcome event (for frontend animation trigger) ────────────────
    socket.emit('system:welcome', {
      message: `Welcome ${socket.user?.name}`,
      role: socket.user?.role
    });

    // ── Client subscribes to a specific patient's feed ─────────────────────
    socket.on('subscribe:patient', (patientId) => {
      socket.join(`patient:${patientId}`);

      console.log(`👤 ${socket.user.name} subscribed to patient ${patientId}`);

      // Acknowledge subscription (for frontend smooth UX)
      socket.emit('patient:subscribed', {
        patientId,
        status: 'connected'
      });
    });

    // ── Real-time typing / activity indicator ──────────────────────────────
    socket.on('user:activity', (data) => {
      socket.broadcast.emit('user:activity', {
        user: socket.user.name,
        action: data.action
      });
    });

    // ── Nurse sends live vitals from bedside sensor ─────────────────────────
    // Payload: { patientId, heartRate, spo2, bpSystolic, bpDiastolic }
    socket.on('vitals:push', (data) => {
      // Broadcast to everyone in that patient's room + all admins/doctors
      io.to(`patient:${data.patientId}`).emit('vitals:update', data);
      io.to('role:doctor').emit('vitals:update', data);
      io.to('role:admin').emit('vitals:update', data);
    });

    // ── Nurse updates transfer progress ────────────────────────────────────
    // Payload: { transferId, progressPercent, status }
    socket.on('transfer:progress', (data) => {
      io.emit('transfer:progress', data); // Broadcast to all (dashboard shows it)
    });

    // ── Client disconnects ──────────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`🔌 Socket disconnected: ${socket.user?.name}`);
    });
  });

  console.log('🌐 Socket.IO initialized');
};

module.exports = { initSockets };
