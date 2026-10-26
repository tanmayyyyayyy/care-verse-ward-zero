// backend/server.js
// Main entry point — Express app + Socket.IO + MongoDB

require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const mongoose   = require('mongoose');
const path       = require('path');

const connectDB           = require('./config/db');
const aiService           = require('./services/aiService');
const { initSockets }     = require('./sockets/socketManager');
const { errorHandler }    = require('./middleware/errorHandler');

// ── Route imports ────────────────────────────────────────────────────────────
const authRoutes      = require('./routes/authRoutes');
const patientRoutes   = require('./routes/patientRoutes');
const transferRoutes  = require('./routes/transferRoutes');
const alertRoutes     = require('./routes/alertRoutes');
const hospitalRoutes  = require('./routes/hospitalRoutes');
const auditRoutes     = require('./routes/auditRoutes');
const { initBedSensorEmitter } = require('./sockets/bedSensorEmitter');
const { startPatientMonitor } = require('./services/patientMonitorService');

if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET is not set. Refusing to start with broken authentication.');
  process.exit(1);
}

const DEFAULT_CLIENT_ORIGINS = [
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://127.0.0.1:5502',
  'http://localhost:5502',
  'http://localhost:5002',
  'http://127.0.0.1:5002',
];
const CLIENT_ORIGINS = [
  ...new Set([
    ...DEFAULT_CLIENT_ORIGINS,
    ...String(process.env.CLIENT_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  ]),
];

connectDB();

const app = express();
app.disable('x-powered-by');

app.use(helmet({ contentSecurityPolicy: false }));

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || CLIENT_ORIGINS.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Request logging (dev only)
if (process.env.NODE_ENV === 'development') app.use(morgan('dev'));

// Body parsers
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Static frontend files ────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '../frontend')));

app.get('/', (req, res) => {
  res.redirect('/login.html');
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/login.html'));
});

app.get('/signup.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/signup.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

app.get('/dashboard.html', (req, res) => {
  res.redirect('/index.html');
});

// ── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',       authRoutes);
app.use('/api/patients',   patientRoutes);
app.use('/api/transfers',  transferRoutes);
app.use('/api/alerts',     alertRoutes);
app.use('/api/hospitals',  hospitalRoutes);
app.use('/api/audit',      auditRoutes);

// ── Health checks ────────────────────────────────────────────────────────────
const MONGO_STATES = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    status: 'ok',
    message: 'MedBed OS API is running',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV,
  });
});

app.get('/api/health/ready', async (req, res) => {
  const readyState = mongoose.connection.readyState;
  let mongoStatus = readyState === 1 ? 'up' : 'down';
  let mongoError;

  if (mongoStatus === 'up') {
    try {
      if (!mongoose.connection.db) {
        throw new Error('MongoDB connection is not initialized');
      }
      await mongoose.connection.db.admin().command({ ping: 1, maxTimeMS: 1000 });
    } catch (error) {
      mongoStatus = 'down';
      mongoError = error.message;
    }
  }

  const ai = await aiService.checkHealth();
  const databaseReady = mongoStatus === 'up';
  const overallStatus = databaseReady
    ? ai.status === 'up'
      ? 'ready'
      : 'degraded'
    : 'not_ready';

  res.status(databaseReady ? 200 : 503).json({
    success: databaseReady,
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    checks: {
      mongodb: {
        status: mongoStatus,
        required: true,
        readyState,
        state: MONGO_STATES[readyState] || 'unknown',
        ...(mongoError ? { error: mongoError } : {}),
      },
      ai: {
        ...ai,
        required: false,
      },
    },
    degraded: databaseReady && ai.status !== 'up',
  });
});

// ── 404 handler ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (!req.originalUrl.startsWith('/api')) {
    return res.redirect('/login.html');
  }
  res.status(404).json({ success: false, message: `Route ${req.originalUrl} not found.` });
});

// ── Global error handler ─────────────────────────────────────────────────────
app.use(errorHandler);

// ── HTTP server + Socket.IO ──────────────────────────────────────────────────
const httpServer = http.createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || CLIENT_ORIGINS.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingTimeout: 60000,
});

// Make io accessible inside controllers via req.app.get('io')
app.set('io', io);

// Boot socket handlers
initSockets(io);

initBedSensorEmitter(io);
// ── Start listening ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`\n🚀  MedBed OS backend running`);
  console.log(`    ➜  API   : http://localhost:${PORT}/api`);
  console.log(`    ➜  Health: http://localhost:${PORT}/api/health`);
  console.log(`    ➜  Mode  : ${process.env.NODE_ENV || 'development'}\n`);
  startPatientMonitor(io);
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
process.on('unhandledRejection', (err) => {
  console.error('💥 Unhandled rejection:', err.message);
  httpServer.close(() => process.exit(1));
});
const shutdown = (signal) => {
  console.log(`👋 ${signal} received — shutting down gracefully`);
  httpServer.close(() => process.exit(0));
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
