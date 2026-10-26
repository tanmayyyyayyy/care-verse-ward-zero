const DEFAULT_STALE_SECONDS = Number(process.env.VITALS_STALE_SECONDS) || 60;
const DEFAULT_OFFLINE_SECONDS = Number(process.env.SENSOR_OFFLINE_SECONDS) || 180;

const getVitalsTimestamp = (vitals) => {
  if (!vitals) return null;
  const value = vitals.observedAt || vitals.deviceTimestamp || vitals.recordedAt || vitals.receivedAt;
  if (!value) return null;
  const timestamp = value instanceof Date ? value : new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
};

const assessVitalsQuality = (
  latestVitals,
  now = Date.now(),
  {
    staleSeconds = DEFAULT_STALE_SECONDS,
    offlineSeconds = DEFAULT_OFFLINE_SECONDS,
  } = {}
) => {
  const timestamp = getVitalsTimestamp(latestVitals);
  const thresholds = { staleSeconds, offlineSeconds };

  if (!timestamp) {
    return {
      status: 'no_data',
      label: 'No data',
      isLive: false,
      isStale: true,
      isOffline: false,
      ageSeconds: null,
      lastReadingAt: null,
      thresholds,
      message: 'No sensor readings received. Stability must not be assumed.',
    };
  }

  const ageSeconds = Math.max(0, Math.floor((now - timestamp.getTime()) / 1000));
  let status = 'live';
  let label = 'Live';
  let message = 'Fresh sensor data is available.';

  if (ageSeconds >= offlineSeconds) {
    status = 'offline';
    label = 'Offline';
    message = `No reading for ${ageSeconds}s. Sensor is offline; treat current state as unknown.`;
  } else if (ageSeconds >= staleSeconds) {
    status = 'stale';
    label = 'Stale';
    message = `Latest reading is ${ageSeconds}s old. Do not treat stale data as stable.`;
  }

  return {
    status,
    label,
    isLive: status === 'live',
    isStale: status !== 'live',
    isOffline: status === 'offline',
    ageSeconds,
    lastReadingAt: timestamp.toISOString(),
    thresholds,
    message,
  };
};

module.exports = {
  assessVitalsQuality,
  getVitalsTimestamp,
  DEFAULT_STALE_SECONDS,
  DEFAULT_OFFLINE_SECONDS,
};
