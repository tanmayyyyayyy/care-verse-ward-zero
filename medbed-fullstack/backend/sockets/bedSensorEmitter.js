// backend/sockets/bedSensorEmitter.js
const ml = require('../services/mlPredictionService');

function initBedSensorEmitter(io) {
  let state = {
    weight: 78.5,
    leftPressure: 48,
    rightPressure: 52,
    tiltAngle: 2.0,
    batteryLevel: 78,
  };

  let tickCount = 0;

  setInterval(async () => {
    tickCount++;
    state.weight += (Math.random() - 0.5) * 0.3;
    state.tiltAngle += (Math.random() - 0.5) * 1.2;
    state.leftPressure += Math.floor((Math.random() - 0.5) * 4);
    state.leftPressure = Math.max(10, Math.min(90, state.leftPressure));
    state.rightPressure = 100 - state.leftPressure;

    const imbalance = Math.abs(state.leftPressure - state.rightPressure);
    const risk =
      Math.abs(state.tiltAngle) > 10 || imbalance > 20 ? 'High' : 'Low';
    const stabilityScore = Math.min(
      100,
      Math.round((Math.abs(state.tiltAngle) / 13) * 50 + (imbalance / 60) * 50)
    );

    // Run ML safety inference every 2 ticks (4 seconds) or on high risk
    let mlSafety = null;
    if (tickCount % 2 === 0 || risk === 'High') {
      try {
        mlSafety = await ml.predictSafety({
          weight_kg: Number(state.weight.toFixed(1)),
          age: 65,
          is_sedated: 0,
          sensor_head: 8.0,
          sensor_torso: Number((state.weight * 0.45).toFixed(1)),
          sensor_leg_left: Number(
            (state.weight * 0.25 * (state.leftPressure / 50)).toFixed(1)
          ),
          sensor_leg_right: Number(
            (state.weight * 0.25 * (state.rightPressure / 50)).toFixed(1)
          ),
          sensor_foot: 3.0,
          accel_x: 0.02,
          accel_y: 0.01,
          accel_z: 9.81,
          gyro_roll: Number(state.tiltAngle.toFixed(2)),
          gyro_pitch: 1.0,
          rail_left_locked: 1,
          rail_right_locked: 1,
          bed_angle: 30.0,
          movement_30s: risk === 'High' ? 12 : 2,
        });
      } catch (err) {
        // Fallback handled inside mlPredictionService
      }
    }

    io.emit('bed:sensor', {
      ...state,
      stabilityScore,
      stabilityRisk: risk,
      mlSafety,
    });

    if (mlSafety) {
      io.emit('ml:safety_prediction', {
        bedId: 'Z-SIM',
        timestamp: new Date().toISOString(),
        prediction: mlSafety,
        isFallRisk: mlSafety.fall_risk_prob > 0.35,
        isImbalanced: mlSafety.imbalance_detected === 1,
        isSafetyCrit: mlSafety.safety_alert === 2,
      });
    }
  }, 2000);

  console.log('🛏 Smart Bed Digital Twin emitter started (with ML safety integration)');
}

module.exports = { initBedSensorEmitter };