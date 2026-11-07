'use strict';

const Patient = require('../models/Patient');
const Vitals = require('../models/Vitals');
const { ingestVitals } = require('./vitalsIngestionService');
const { SensorReplayBuffer } = require('./sensorReplayBuffer');
const { generateScenarioReading } = require('./sensorSimulator');
const aiService = require('./aiService');

/**
 * Simulated "home gateway" sitting between bedroom sensors and the platform.
 *
 * It makes the reliability behaviour of SensorReplayBuffer observable end to end:
 *   link UP   -> readings are ingested immediately
 *   link DOWN -> readings are queued (ordered, de-duplicable, optionally durable)
 *   link UP   -> queue is replayed FIFO with original timestamps + reading IDs;
 *                the platform de-duplicates and flags late arrivals.
 *
 * It also supports failure injection for demonstrating resilience under stress:
 *   - pause sensor
 *   - delay data N seconds
 *   - send duplicate/out-of-order readings
 *   - simulate AI service down (activates rule fallback badge)
 *   - simulate network drop (queues in buffer)
 */

let ioRef = null;
const stats = { lastEnqueuedAt: null, lastOutageStartedAt: null, lastOutageEndedAt: null, lastReplayCount: 0 };

const pausedSensors = new Set();
let isAllSensorsPaused = false;
let delaySeconds = 0;
let delayedFlushTimer = null;

const pauseSensor = (patientId = 'all', paused = true) => {
  if (patientId === 'all') {
    isAllSensorsPaused = Boolean(paused);
    if (!paused) pausedSensors.clear();
  } else if (paused) {
    pausedSensors.add(String(patientId));
  } else {
    pausedSensors.delete(String(patientId));
  }
  broadcast();
  return getStatus();
};

const isSensorPaused = (patientId) => {
  if (isAllSensorsPaused) return true;
  if (!patientId) return isAllSensorsPaused || pausedSensors.size > 0;
  return pausedSensors.has(String(patientId));
};

const setDelay = (seconds) => {
  delaySeconds = Math.max(0, Number(seconds) || 0);
  broadcast();
  return getStatus();
};

const getDelay = () => delaySeconds;

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

const getStatus = (patientId = null) => {
  const isDown = typeof aiService?.isSimulatedDown === 'function' ? aiService.isSimulatedDown() : false;
  return {
    ...buffer.getStatus(),
    ...stats,
    isSensorPaused: isSensorPaused(patientId),
    pausedSensors: Array.from(pausedSensors),
    delaySeconds,
    aiSimulatedDown: isDown,
    fallbackActive: isDown,
  };
};

const broadcast = () => {
  if (ioRef) {
    ioRef
      .to('role:doctor')
      .to('role:nurse')
      .to('role:admin')
      .emit('gateway:status', getStatus());

    ioRef
      .to('role:doctor')
      .to('role:nurse')
      .to('role:admin')
      .emit('failure_injection:update', getStatus());
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
  if (isSensorPaused(patientId)) {
    return {
      queued: false,
      paused: true,
      message: 'Sensor paused by failure injection',
      readingId: reading?.readingId,
      status: getStatus(patientId),
    };
  }

  const item = buffer.enqueue({ ...reading, patientId: String(patientId) });
  stats.lastEnqueuedAt = new Date().toISOString();

  if (!buffer.isOnline) {
    broadcast();
    return { queued: true, readingId: item.readingId, status: getStatus() };
  }

  if (delaySeconds > 0) {
    if (delayedFlushTimer) clearTimeout(delayedFlushTimer);
    delayedFlushTimer = setTimeout(async () => {
      delayedFlushTimer = null;
      await buffer.flush();
      broadcast();
    }, delaySeconds * 1000);

    broadcast();
    return {
      queued: true,
      delayed: true,
      delaySeconds,
      readingId: item.readingId,
      status: getStatus(),
    };
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
  if (isSensorPaused(patient._id)) {
    return {
      submitted: [],
      paused: true,
      message: 'Sensor paused by failure injection',
      status: getStatus(patient._id),
    };
  }

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
      paused: outcome.paused || false,
    });
  }
  return { submitted, status: getStatus() };
};

const injectDuplicate = async (patient) => {
  const latest = await Vitals.findOne({ patient: patient._id }).sort({ observedAt: -1, recordedAt: -1 });
  let reading;
  if (latest) {
    reading = {
      heartRate: latest.heartRate,
      spo2: latest.spo2,
      bpSystolic: latest.bpSystolic,
      bpDiastolic: latest.bpDiastolic,
      respiratoryRate: latest.respiratoryRate,
      temperature: latest.temperature,
      readingId: latest.readingId,
      deviceTimestamp: latest.deviceTimestamp || latest.observedAt || latest.recordedAt,
      deviceId: latest.deviceId,
      source: 'simulation',
    };
  } else {
    reading = generateScenarioReading(patient, 'stable');
    await submit(patient._id, reading);
  }
  const outcome = await submit(patient._id, reading);
  return { injected: 'duplicate', readingId: reading.readingId, outcome, status: getStatus() };
};

const injectOutOfOrder = async (patient) => {
  const latest = await Vitals.findOne({ patient: patient._id }).sort({ observedAt: -1, recordedAt: -1 });
  const baseTime = latest?.deviceTimestamp ? new Date(latest.deviceTimestamp).getTime() : Date.now();
  const outOfOrderTime = new Date(baseTime - 15 * 60 * 1000);
  const reading = {
    ...generateScenarioReading(patient, 'stable', { now: outOfOrderTime }),
    deviceTimestamp: outOfOrderTime.toISOString(),
    observedAt: outOfOrderTime.toISOString(),
  };
  const outcome = await submit(patient._id, reading);
  return {
    injected: 'out_of_order',
    readingId: reading.readingId,
    deviceTimestamp: outOfOrderTime.toISOString(),
    outcome,
    status: getStatus(),
  };
};

const injectFault = async (action, options = {}) => {
  let result = {};
  const patientId = options.patientId || 'all';

  switch (action) {
    case 'pause_sensor':
      pauseSensor(patientId, options.paused !== false);
      result = { action, paused: isSensorPaused(patientId), patientId };
      break;

    case 'resume_sensor':
      pauseSensor(patientId, false);
      result = { action, paused: false, patientId };
      break;

    case 'delay_data':
      setDelay(options.delaySeconds ?? options.delay ?? 5);
      result = { action, delaySeconds: getDelay() };
      break;

    case 'simulate_ai_down':
      aiService.setSimulatedDown(options.down !== false);
      result = { action, aiSimulatedDown: aiService.isSimulatedDown(), fallbackActive: aiService.isSimulatedDown() };
      break;

    case 'restore_ai':
      aiService.setSimulatedDown(false);
      result = { action, aiSimulatedDown: false, fallbackActive: false };
      break;

    case 'simulate_network_drop':
      await setConnectivity(false);
      result = { action, networkOnline: false, status: getStatus() };
      break;

    case 'reconnect_network':
      await setConnectivity(true);
      result = { action, networkOnline: true, status: getStatus() };
      break;

    case 'send_duplicate': {
      const patient = await Patient.findById(options.patientId);
      if (!patient) throw new Error('Active patient required for duplicate injection');
      result = await injectDuplicate(patient);
      break;
    }

    case 'send_out_of_order': {
      const patient = await Patient.findById(options.patientId);
      if (!patient) throw new Error('Active patient required for out-of-order injection');
      result = await injectOutOfOrder(patient);
      break;
    }

    case 'duplicate_or_out_of_order': {
      const patient = await Patient.findById(options.patientId);
      if (!patient) throw new Error('Active patient required for duplicate/out-of-order injection');
      const dup = await injectDuplicate(patient);
      const ooo = await injectOutOfOrder(patient);
      result = { action, duplicate: dup, outOfOrder: ooo };
      break;
    }

    case 'reset':
    case 'reset_faults':
      pauseSensor('all', false);
      setDelay(0);
      aiService.setSimulatedDown(false);
      if (delayedFlushTimer) {
        clearTimeout(delayedFlushTimer);
        delayedFlushTimer = null;
      }
      await setConnectivity(true);
      result = { action: 'reset', message: 'All injected failures cleared', status: getStatus() };
      break;

    default:
      throw new Error(`Unsupported failure injection action: ${action}`);
  }

  broadcast();
  return { success: true, ...result, status: getStatus() };
};

const reset = () => {
  buffer.clear();
  buffer.isOnline = true;
  pausedSensors.clear();
  isAllSensorsPaused = false;
  delaySeconds = 0;
  if (delayedFlushTimer) {
    clearTimeout(delayedFlushTimer);
    delayedFlushTimer = null;
  }
  aiService.setSimulatedDown(false);
  Object.assign(stats, {
    lastEnqueuedAt: null,
    lastOutageStartedAt: null,
    lastOutageEndedAt: null,
    lastReplayCount: 0,
  });
  broadcast();
  return getStatus();
};

module.exports = {
  init,
  getStatus,
  setConnectivity,
  submit,
  emitScenario,
  reset,
  buffer,
  pauseSensor,
  isSensorPaused,
  setDelay,
  getDelay,
  injectDuplicate,
  injectOutOfOrder,
  injectFault,
};
