// backend/config/db.js
// Handles MongoDB connection via Mongoose

const mongoose = require('mongoose');

const RETRY_DELAY_MS = 10000;

mongoose.connection.on('disconnected', () => {
  console.warn('⚠️  MongoDB disconnected. Mongoose will attempt to reconnect.');
});
mongoose.connection.on('reconnected', () => {
  console.log('✅  MongoDB reconnected');
});
mongoose.connection.on('error', (error) => {
  console.error(`❌  MongoDB connection error: ${error.message}`);
});

const connectDB = async () => {
  const mongoUri = process.env.MONGO_URI;

  if (!mongoUri) {
    console.error('❌  MONGO_URI is not set. Copy .env.example to .env and configure MongoDB.');
    return;
  }

  try {
    const conn = await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 15000,
    });

    console.log(`✅  MongoDB connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌  MongoDB connection error: ${error.message}`);
    console.warn(
      `Readiness will report not_ready; retrying in ${RETRY_DELAY_MS / 1000}s.`
    );
    setTimeout(connectDB, RETRY_DELAY_MS);
  }
};

module.exports = connectDB;
