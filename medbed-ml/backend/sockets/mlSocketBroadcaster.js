// backend/sockets/mlSocketBroadcaster.js
// ─────────────────────────────────────────────────────────────────────────────
// Bridges live sensor data → ML predictions → Socket.IO dashboard events.
//
// Architecture:
//   Sensor / nurse device
//       ↓  socket event (vitals:push, safety:push)
//   mlSocketBroadcaster
//       ↓  HTTP POST to Python ML API (async, non-blocking)
//   Python ML Service
//       ↓  predictions JSON
//   Socket.IO broadcast
//       ↓  ml:vitals_prediction, ml:safety_prediction, ml:transfer_prediction
//   React/Vanilla JS dashboard (live update)
//
// Integration: call initMLBroadcaster(io) in your server.js
// ─────────────────────────────────────────────────────────────────────────────

const ml = require('../services/mlPredictionService');

// ── Rolling vitals window (per patient) ──────────────────────────────────────
// Keeps last N readings before sending to LSTM
const VITALS_WINDOW = 10;
const vitalsBuffers  = new Map(); // patientId → { hr:[], spo2:[], bp:[] }

function getVitalsBuffer(patientId) {
  if (!vitalsBuffers.has(patientId)) {
    vitalsBuffers.set(patientId, { hr: [], spo2: [], bp: [] });
  }
  return vitalsBuffers.get(patientId);
}

function pushToBuffer(buf, key, value) {
  buf[key].push(value);
  if (buf[key].length > VITALS_WINDOW) buf[key].shift();
}

// ══════════════════════════════════════════════════════════════════════════════
// Main initialiser
// ══════════════════════════════════════════════════════════════════════════════

function initMLBroadcaster(io) {
  io.on('connection', (socket) => {

    // ── EVENT: Real-time vitals pushed by nurse/sensor device ─────────────────
    // Payload: { patientId, heartRate, spo2, bpSystolic, age, condition, isPostSurgery }
    socket.on('vitals:push', async (data) => {
      const { patientId, heartRate, spo2, bpSystolic, age = 60,
              condition = 0, isPostSurgery = 0 } = data;

      if (!patientId || !heartRate || !spo2) return;

      // Add to rolling buffer
      const buf = getVitalsBuffer(patientId);
      pushToBuffer(buf, 'hr',   heartRate);
      pushToBuffer(buf, 'spo2', spo2);
      pushToBuffer(buf, 'bp',   bpSystolic || 120);

      // Only predict once we have enough data (or send anyway with padding)
      try {
        const prediction = await ml.predictVitals({
          heart_rate:     buf.hr,
          spo2:           buf.spo2,
          blood_pressure: buf.bp,
          age,
          condition,
          is_post_surgery: isPostSurgery ? 1 : 0,
        });

        // Broadcast prediction to all subscribers of this patient
        const payload = {
          patientId,
          timestamp:  new Date().toISOString(),
          vitals: { heartRate, spo2, bpSystolic },
          prediction,
          // Helper flags for frontend to use directly
          isWarning:  prediction.alert_class === 1,
          isCritical: prediction.alert_class === 2,
          deteriorationRisk: prediction.deterioration_prob,
        };

        io.to(`patient:${patientId}`).emit('ml:vitals_prediction', payload);
        io.to('role:doctor').emit('ml:vitals_prediction', payload);

        // Fire alert if critical
        if (prediction.alert_class === 2) {
          io.emit('alert:new', {
            type:     'vitals_critical',
            severity: 'critical',
            patientId,
            message:  `CRITICAL: Vitals deteriorating — ${prediction.alert_label} (${(prediction.deterioration_prob * 100).toFixed(0)}% risk)`,
            timestamp: new Date().toISOString(),
          });
        } else if (prediction.alert_class === 1) {
          io.to('role:doctor').emit('alert:new', {
            type:     'vitals_warning',
            severity: 'warning',
            patientId,
            message:  `Warning: ${prediction.alert_label} — monitoring recommended`,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.error('[ML] vitals:push prediction failed:', err.message);
      }
    });


    // ── EVENT: Bed sensor data pushed for safety analysis ─────────────────────
    // Payload: { patientId, bedId, sensorReadings: { head, torso, legL, legR, foot },
    //            accelerometer: {x,y,z}, gyroscope: {roll,pitch},
    //            rails: {left, right}, bedAngle, movement30s,
    //            patientWeight, patientAge }
    socket.on('safety:push', async (data) => {
      const {
        patientId, bedId,
        sensorReadings: { head=0, torso=0, legL=0, legR=0, foot=0 } = {},
        accelerometer:  { x=0, y=0, z=9.81 } = {},
        gyroscope:      { roll=0, pitch=0 }  = {},
        rails:          { left=1, right=1 }  = {},
        bedAngle       = 30,
        movement30s    = 0,
        patientWeight  = 70,
        patientAge     = 60,
        isSedated      = 0,
      } = data;

      try {
        const prediction = await ml.predictSafety({
          weight_kg:         patientWeight,
          age:               patientAge,
          is_sedated:        isSedated ? 1 : 0,
          sensor_head:       head,
          sensor_torso:      torso,
          sensor_leg_left:   legL,
          sensor_leg_right:  legR,
          sensor_foot:       foot,
          accel_x:           x,
          accel_y:           y,
          accel_z:           z,
          gyro_roll:         roll,
          gyro_pitch:        pitch,
          rail_left_locked:  left  ? 1 : 0,
          rail_right_locked: right ? 1 : 0,
          bed_angle:         bedAngle,
          movement_30s:      movement30s,
        });

        const payload = {
          patientId,
          bedId,
          timestamp: new Date().toISOString(),
          prediction,
          isFallRisk:    prediction.fall_risk_prob > 0.35,
          isImbalanced:  prediction.imbalance_detected === 1,
          isSafetyCrit:  prediction.safety_alert === 2,
        };

        io.to(`patient:${patientId}`).emit('ml:safety_prediction', payload);
        io.to('role:nurse').emit('ml:safety_prediction', payload);

        // Fire alert if dangerous
        if (prediction.safety_alert === 2) {
          io.emit('alert:new', {
            type:     'fall_risk_critical',
            severity: 'critical',
            patientId, bedId,
            message:  `CRITICAL FALL RISK: ${(prediction.fall_risk_prob * 100).toFixed(0)}% probability detected on Bed ${bedId}`,
            timestamp: new Date().toISOString(),
          });
        } else if (prediction.imbalance_detected) {
          io.to('role:nurse').emit('alert:new', {
            type:     'imbalance_warning',
            severity: 'warning',
            patientId, bedId,
            message:  `Bed imbalance detected on Bed ${bedId} (${(prediction.imbalance_prob * 100).toFixed(0)}% confidence)`,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.error('[ML] safety:push prediction failed:', err.message);
      }
    });


    // ── EVENT: Pre-transfer assessment request ────────────────────────────────
    // Payload: full patient + transfer data
    socket.on('transfer:assess', async (data) => {
      const { patientId, transferId, ...transferData } = data;

      try {
        const prediction = await ml.predictTransfer({
          age:               transferData.age,
          weight_kg:         transferData.weight,
          condition:         transferData.condition,
          department_from:   transferData.fromDept,
          department_to:     transferData.toDept,
          heart_rate:        transferData.heartRate,
          spo2:              transferData.spo2,
          bp_systolic:       transferData.bpSystolic,
          bp_diastolic:      transferData.bpDiastolic,
          transfer_distance: transferData.distance,
          time_of_day:       new Date().getHours(),
          is_post_surgery:   transferData.isPostSurgery ? 1 : 0,
          equipment_count:   transferData.equipmentCount || 0,
        });

        const payload = {
          patientId,
          transferId,
          timestamp: new Date().toISOString(),
          prediction,
          recommendation: prediction.risk_level === 2
            ? 'delay_transfer'
            : prediction.risk_level === 1
              ? 'proceed_with_caution'
              : 'proceed',
        };

        // Return to requesting socket + notify doctors
        socket.emit('ml:transfer_assessment', payload);
        io.to('role:doctor').emit('ml:transfer_assessment', payload);
        io.to('role:admin').emit('ml:transfer_assessment', payload);

      } catch (err) {
        socket.emit('ml:transfer_assessment', {
          patientId, transferId,
          error: 'ML assessment unavailable',
          fallback: true,
        });
      }
    });

  });

  console.log('🤖  ML Socket Broadcaster initialised');
}

module.exports = { initMLBroadcaster };
