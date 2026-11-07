'use strict';

const Patient = require('../models/Patient');
const { ingestVitals } = require('./vitalsIngestionService');
const { SensorReplayBuffer } = require('./sensorReplayBuffer');
const { generateScenarioReading } = require('./sensorSimulator');

/**
 * Simulated "home gateway" sitting between bedroom sensors and the platform.
 *
 * It makes the reliability behaviour of SensorReplayBuffer observable end to end:
 *   link UP   -> readings are ingested immediately
 *   link DOWN -> readings are queued (ordered, de-duplicable, optionally durable)
 *   link UP   -> queue is replayed FIFO with original timestamps + reading IDs;
 *                the platform de-duplicates and flags late arrivals.
 *
 * The queue is module-level (one gateway per backend process), which is exactly
 * the right granularity for a one-room demo. A real deployment would run one
 * buffer per home hub.
 */

let ioRef = null;
const stats = { lastEnqueuedAt: null, lastOutageStartedAt: null, lastOutageEndedAt: null, lastReplayCount: 0 };

const ingestFromBuffer = async (item) => {
  const patient = await Patient.findById(item.patientId);
  if (!patient || !patient.isActive) {
    const error = new Error('Patient not found for buffered reading');
    error.statusCode = 404;
    throw error;
  }
  const {
    patientId,
    enqueuedAt,
    attempts,
    lastAttemptAt,
    lastError,
    observedAt,
    scenario,
    scenarioStep,
    ...payload
  } = item;
  return ingestVitals({ patient, payload, io: ioRef });
};

const buffer = new SensorReplayBuffer({
  ingestFn: ingestFromBuffer,
  isOnline: true,
  autoFlush: true,
  initialBackoffMs: Number(process.env.GATEWAY_BACKOFF_MS) || 500,
  maxBackoffMs: Number(process.env.GATEWAY_MAX_BACKOFF_MS) || 8000,
  storagePath: process.env.GATEWAY_BUFFER_PATH || null,
});

const init = (io) => {
  ioRef = io;
};

const getStatus = () => ({ ...buffer.getStatus(), ...stats });

const broadcast = () => {
  if (ioRef) {
    ioRef
      .to('role:doctor')
      .to('role:nurse')
      .to('role:admin')
      .emit('gateway:status', getStatus());
  }
};

const setConnectivity = async (online) => {
  const goingOffline = !online && buffer.isOnline;
  const comingOnline = online && !buffer.isOnline;
  const queuedBefore = buffer.queue.length;
  if (goingOffline) stats.lastOutageStartedAt = new Date().toISOString();

  const status = await buffer.setOnline(online);

  if (comingOnline) {
    stats.lastOutageEndedAt = new Date().toISOString();
    stats.lastReplayCount = queuedBefore - buffer.queue.length;
  }
  broadcast();
  return { ...status, ...stats };
};

/**
 * Submit one reading through the gateway.
 * @returns {{queued:boolean, result?:object, status:object}}
 */
const submit = async (patientId, reading) => {
  const item = buffer.enqueue({ ...reading, patientId: String(patientId) });
  stats.lastEnqueuedAt = new Date().toISOString();

  if (!buffer.isOnline) {
    broadcast();
    return { queued: true, readingId: item.readingId, status: getStatus() };
  }

  await buffer.flush();
  broadcast();
  return {
    queued: buffer.queue.some((q) => q.readingId === item.readingId),
    readingId: item.readingId,
    status: getStatus(),
  };
};

/** Generate synthetic scenario readings and push them through the gateway. */
const emitScenario = async (patient, scenario, steps = 1) => {
  const submitted = [];
  const base = Date.now();
  for (let i = 0; i < steps; i += 1) {
    const reading = generateScenarioReading(patient, scenario, { now: new Date(base + i) });
    const outcome = await submit(patient._id, reading);
    submitted.push({
      readingId: reading.readingId,
      heartRate: reading.heartRate,
      spo2: reading.spo2,
      bpSystolic: reading.bpSystolic,
      respiratoryRate: reading.respiratoryRate,
      scenarioStep: reading.scenarioStep,
      queued: outcome.queued,
    });
  }
  return { submitted, status: getStatus() };
};

const reset = () => {
  buffer.clear();
  buffer.isOnline = true;
  Object.assign(stats, {
    lastEnqueuedAt: null,
    lastOutageStartedAt: null,
    lastOutageEndedAt: null,
    lastReplayCount: 0,
  });
  broadcast();
  return getStatus();
};

module.exports = { init, getStatus, setConnectivity, submit, emitScenario, reset, buffer };
