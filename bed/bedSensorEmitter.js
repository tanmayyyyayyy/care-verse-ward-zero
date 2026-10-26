// backend/sockets/bedSensorEmitter.js
// ─────────────────────────────────────────────────────────────────────────────
// Smart Bed Digital Twin — Backend Socket.IO Emitter
// Emits realistic sensor data every 2 seconds on event: "bed:sensor"
//
// Integration:
//   1. Copy this file to backend/sockets/bedSensorEmitter.js
//   2. In server.js, add:
//        const { initBedSensorEmitter } = require('./sockets/bedSensorEmitter');
//        initBedSensorEmitter(io);
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clamps a value between min and max.
 */
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/**
 * Random walk: nudges a value by ±(spread/2), staying within [min,max].
 */
const drift = (v, spread, min, max) =>
  clamp(v + (Math.random() - 0.5) * spread, min, max);


/**
 * initBedSensorEmitter(io, options?)
 *
 * @param {object} io        — Socket.IO server instance
 * @param {object} options   — Optional overrides
 *   options.intervalMs      — Emit interval (default: 2000ms)
 *   options.bedId           — Bed identifier (default: 'BU-12')
 *   options.patientId       — Patient identifier (default: 'PT-2047')
 *   options.room            — Emit to a specific room (default: broadcast all)
 */
function initBedSensorEmitter(io, options = {}) {
  const {
    intervalMs = 2000,
    bedId      = 'BU-12',
    patientId  = 'PT-2047',
    room       = null,
  } = options;

  // ── Sensor state (smooth random-walk so values look realistic) ─────────────
  let state = {
    weight:      78.5,   // kg   — patient weight
    leftPressure:  48,   // %    — left side pressure sensor
    rightPressure: 52,   // %    — right side (kept as 100-left)
    tiltAngle:    2.0,   // deg  — bed tilt (negative = head down)
    wheelLock:    true,  // bool
    oxygenMounted:true,  // bool
    batteryLevel: 78,    // %
  };

  // ── Simulate occasional events for demo realism ─────────────────────────────
  let tickCount = 0;

  const emitBedData = () => {
    tickCount++;

    // ── Update state with realistic random walk ──────────────────────────────
    state.weight       = parseFloat(drift(state.weight,      0.3, 55,  112).toFixed(1));
    state.tiltAngle    = parseFloat(drift(state.tiltAngle,   1.2, -12,  14).toFixed(1));
    state.leftPressure = Math.round(drift(state.leftPressure, 4,   10,   90));
    state.rightPressure= 100 - state.leftPressure;
    state.batteryLevel = parseFloat(drift(state.batteryLevel, 0.15, 5, 100).toFixed(1));

    // ── Simulate occasional wheel unlock / O2 removal for demo drama ─────────
    // Every ~30 ticks (60s), briefly unlock wheel to trigger alert
    if (tickCount % 30 === 0) state.wheelLock    = false;
    else if (tickCount % 30 === 2) state.wheelLock = true;
    // Every ~50 ticks, briefly remove O2
    if (tickCount % 50 === 0) state.oxygenMounted = false;
    else if (tickCount % 50 === 3) state.oxygenMounted = true;
    // Random unlock (5% chance per tick)
    if (Math.random() < 0.05) state.wheelLock = false;
    if (Math.random() < 0.95 && !state.wheelLock) state.wheelLock = true;

    // ── Compute derived fields ────────────────────────────────────────────────
    const imbalance   = Math.abs(state.leftPressure - state.rightPressure);
    const tiltFactor  = Math.abs(state.tiltAngle) / 14;
    const imbFactor   = imbalance / 60;
    const stabScore   = Math.min(100, Math.round(tiltFactor * 50 + imbFactor * 50));
    const stabRisk    = stabScore > 55 ? 'High' : stabScore > 25 ? 'Medium' : 'Low';

    // ── Build payload ─────────────────────────────────────────────────────────
    const payload = {
      bedId,
      patientId,
      timestamp:       new Date().toISOString(),
      weight:          state.weight,
      leftPressure:    state.leftPressure,
      rightPressure:   state.rightPressure,
      tiltAngle:       state.tiltAngle,
      wheelLock:       state.wheelLock,
      oxygenMounted:   state.oxygenMounted,
      batteryLevel:    Math.round(state.batteryLevel),
      stabilityScore:  stabScore,
      stabilityRisk:   stabRisk,
      // Flags for quick frontend checks
      alerts: {
        tiltExceeded:     Math.abs(state.tiltAngle) > 10,
        pressureImbalance:imbalance > 20,
        wheelUnlocked:    !state.wheelLock,
        o2Removed:        !state.oxygenMounted,
        lowBattery:       state.batteryLevel < 20,
        highRisk:         stabRisk === 'High',
      },
    };

    // ── Emit ─────────────────────────────────────────────────────────────────
    if (room) {
      io.to(room).emit('bed:sensor', payload);
    } else {
      io.emit('bed:sensor', payload);                         // broadcast all
      io.to(`patient:${patientId}`).emit('bed:sensor', payload); // patient room
    }

    // Log critical events
    if (payload.alerts.highRisk || payload.alerts.tiltExceeded) {
      console.warn(`[BedSensor] ⚠️  ${bedId}: risk=${stabRisk}, tilt=${state.tiltAngle}°, imbalance=${imbalance}%`);
    }
  };

  // ── Start interval ────────────────────────────────────────────────────────
  const interval = setInterval(emitBedData, intervalMs);
  emitBedData(); // fire immediately on start

  console.log(`🛏  Bed sensor emitter started: ${bedId} → event "bed:sensor" every ${intervalMs}ms`);

  // Return cleanup function
  return () => {
    clearInterval(interval);
    console.log(`🛏  Bed sensor emitter stopped: ${bedId}`);
  };
}

// ── Support multiple beds ─────────────────────────────────────────────────────
/**
 * initMultipleBedEmitters(io, beds)
 * @param {object} io    — Socket.IO server instance
 * @param {Array}  beds  — Array of { bedId, patientId, intervalMs? }
 *
 * Example:
 *   initMultipleBedEmitters(io, [
 *     { bedId: 'BU-12', patientId: 'PT-2047' },
 *     { bedId: 'BU-07', patientId: 'PT-2039', intervalMs: 3000 },
 *   ]);
 */
function initMultipleBedEmitters(io, beds = []) {
  const cleanups = beds.map(bed =>
    initBedSensorEmitter(io, {
      bedId:      bed.bedId,
      patientId:  bed.patientId,
      intervalMs: bed.intervalMs || 2000,
    })
  );
  return () => cleanups.forEach(fn => fn());
}

module.exports = { initBedSensorEmitter, initMultipleBedEmitters };


/* ════════════════════════════════════════════════════════════════════════════
   INTEGRATION INSTRUCTIONS
   ────────────────────────────────────────────────────────────────────────────

   In backend/server.js, add these 2 lines:

   const { initBedSensorEmitter } = require('./sockets/bedSensorEmitter');
   initBedSensorEmitter(io);

   That's it. The frontend will start receiving "bed:sensor" events immediately.

   ────────────────────────────────────────────────────────────────────────────
   SAMPLE PAYLOAD EMITTED:
   {
     "bedId":           "BU-12",
     "patientId":       "PT-2047",
     "timestamp":       "2024-03-18T14:32:07.123Z",
     "weight":          78.5,
     "leftPressure":    46,
     "rightPressure":   54,
     "tiltAngle":       3.2,
     "wheelLock":       true,
     "oxygenMounted":   true,
     "batteryLevel":    77,
     "stabilityScore":  18,
     "stabilityRisk":   "Low",
     "alerts": {
       "tiltExceeded":      false,
       "pressureImbalance": false,
       "wheelUnlocked":     false,
       "o2Removed":         false,
       "lowBattery":        false,
       "highRisk":          false
     }
   }
════════════════════════════════════════════════════════════════════════════ */
