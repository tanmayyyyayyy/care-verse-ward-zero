const { test } = require('node:test');
const assert = require('node:assert/strict');
const Patient = require('../models/Patient');
const Vitals = require('../models/Vitals');
const { Alert, AuditLog } = require('../models/index');
const { ingestVitals } = require('../services/vitalsIngestionService');
const { createAlert, buildDedupKey } = require('../services/alertService');
const { assessVitalsQuality } = require('../services/vitalsQuality');
const { SensorReplayBuffer } = require('../services/sensorReplayBuffer');

AuditLog.create = async () => ({ _id: 'mock-audit-1' });

const createMockQuery = (resolvedValue) => {
  const promise = Promise.resolve(resolvedValue);
  promise.sort = () => promise;
  return promise;
};

test('Duplicate reading ID returns duplicate: true without creating records or alerts', async () => {
  const originalFindOne = Vitals.findOne;
  const originalCreate = Vitals.create;

  const mockExisting = {
    _id: 'vitals-existing-1',
    readingId: 'read-dup-01',
    patient: 'pat-1',
    heartRate: 75,
    spo2: 98,
    bpSystolic: 120,
    bpDiastolic: 80,
    predictedRisk: 'low',
    assessmentSource: 'ai',
    aiFlags: {},
    assessmentExplanation: 'Existing reading',
    observedAt: new Date('2026-10-26T10:00:00Z'),
  };

  let createCalled = false;
  Vitals.findOne = (query) => {
    if (query.readingId === 'read-dup-01') return createMockQuery(mockExisting);
    return createMockQuery(null);
  };
  Vitals.create = async () => {
    createCalled = true;
    throw new Error('Should not create duplicate');
  };

  try {
    const patient = { _id: 'pat-1', patientId: 'PT-001', age: 45, condition: 'general', isPostSurgery: false };
    const result = await ingestVitals({
      patient,
      payload: { readingId: 'read-dup-01', heartRate: 75, spo2: 98, bpSystolic: 120, bpDiastolic: 80 },
    });

    assert.equal(result.duplicate, true);
    assert.equal(createCalled, false);
    assert.equal(result.alerts.length, 0);
    assert.equal(result.vitals.readingId, 'read-dup-01');
  } finally {
    Vitals.findOne = originalFindOne;
    Vitals.create = originalCreate;
  }
});

test('Late out-of-order reading is flagged isLate and does NOT overwrite patient risk or create active alerts', async () => {
  const originalFindOne = Vitals.findOne;
  const originalCreate = Vitals.create;
  const originalPatientUpdate = Patient.findByIdAndUpdate;
  const originalAlertCreate = Alert.create;

  const patientId = '507f1f77bcf86cd799439011';
  const vitalsId = '507f1f77bcf86cd799439012';

  const newerReading = {
    _id: '507f1f77bcf86cd799439013',
    readingId: 'read-recent-2',
    patient: patientId,
    deviceTimestamp: new Date('2026-10-26T12:00:00.000Z'),
    observedAt: new Date('2026-10-26T12:00:00.000Z'),
    recordedAt: new Date('2026-10-26T12:00:00.000Z'),
    predictedRisk: 'low',
  };

  let patientRiskUpdated = false;
  let alertCreated = false;
  let createdVitals = null;

  Vitals.findOne = (query) => {
    if (query.readingId) {
      return createMockQuery(null);
    }
    return createMockQuery(newerReading);
  };

  Vitals.create = async (doc) => {
    createdVitals = doc;
    return { ...doc, _id: vitalsId };
  };

  Patient.findByIdAndUpdate = async () => {
    patientRiskUpdated = true;
  };

  Alert.create = async () => {
    alertCreated = true;
    return { _id: '507f1f77bcf86cd799439014' };
  };

  try {
    const patient = {
      _id: patientId,
      patientId: 'PT-001',
      age: 65,
      condition: 'cardiac',
      isPostSurgery: true,
      riskLevel: 'low',
      riskScore: 0.1,
    };

    // Late reading observed at 11:00:00 (1 hour before the newer 12:00:00 reading) with critical HR
    const result = await ingestVitals({
      patient,
      payload: {
        readingId: 'read-late-01',
        deviceTimestamp: '2026-10-26T11:00:00.000Z',
        heartRate: 145, // Abnormal
        spo2: 95,
        bpSystolic: 130,
        bpDiastolic: 85,
      },
    });

    assert.equal(result.isLate, true);
    assert.ok(createdVitals, 'Vitals.create was called');
    assert.equal(createdVitals.isLate, true);
    assert.equal(createdVitals.observedAt.toISOString(), '2026-10-26T11:00:00.000Z');
    // Ensure patient current risk was NOT overwritten by the old reading
    assert.equal(patientRiskUpdated, false);
    // Ensure active alert was NOT created for an old historical reading
    assert.equal(alertCreated, false);
    assert.equal(result.alerts.length, 0);
  } finally {
    Vitals.findOne = originalFindOne;
    Vitals.create = originalCreate;
    Patient.findByIdAndUpdate = originalPatientUpdate;
    Alert.create = originalAlertCreate;
  }
});

test('Correct latest-measurement selection preserves newer observation over late arrivals', () => {
  const readings = [
    {
      readingId: 'r-late-arrival',
      deviceTimestamp: new Date('2026-10-26T10:00:00.000Z'),
      observedAt: new Date('2026-10-26T10:00:00.000Z'),
      receivedAt: new Date('2026-10-26T10:30:00.000Z'), // received later!
      heartRate: 140,
    },
    {
      readingId: 'r-latest-valid',
      deviceTimestamp: new Date('2026-10-26T10:20:00.000Z'),
      observedAt: new Date('2026-10-26T10:20:00.000Z'),
      receivedAt: new Date('2026-10-26T10:20:05.000Z'),
      heartRate: 76,
    },
  ];

  // Simulating MongoDB sort({ observedAt: -1, recordedAt: -1 })
  const latestByObservation = [...readings].sort(
    (a, b) => b.observedAt.getTime() - a.observedAt.getTime()
  )[0];

  assert.equal(latestByObservation.readingId, 'r-latest-valid');
  assert.equal(latestByObservation.heartRate, 76);
  assert.notEqual(latestByObservation.readingId, 'r-late-arrival');
});

test('Database failure during ingestion is propagated for retry; race duplicate handled safely', async () => {
  const originalFindOne = Vitals.findOne;
  const originalCreate = Vitals.create;

  // 1. Transient DB failure bubbles error
  Vitals.findOne = () => createMockQuery(null);
  Vitals.create = async () => {
    const dbErr = new Error('MongoServerSelectionError: connection timeout');
    dbErr.name = 'MongoServerSelectionError';
    throw dbErr;
  };

  const patient = { _id: 'pat-1', patientId: 'PT-001', age: 50, condition: 'general', isPostSurgery: false };

  await assert.rejects(
    async () => {
      await ingestVitals({
        patient,
        payload: { readingId: 'r-fail', heartRate: 72, spo2: 98, bpSystolic: 120, bpDiastolic: 80 },
      });
    },
    /MongoServerSelectionError/
  );

  // 2. Duplicate key race condition (E11000) is caught and handled safely
  const existingVitals = {
    readingId: 'r-race',
    predictedRisk: 'low',
    assessmentSource: 'ai',
    aiFlags: {},
    assessmentExplanation: 'Safe',
    observedAt: new Date(),
  };
  Vitals.findOne = (query) => {
    if (query.readingId === 'r-race') return createMockQuery(existingVitals);
    return createMockQuery(null);
  };
  Vitals.create = async () => {
    const dupErr = new Error('E11000 duplicate key error');
    dupErr.code = 11000;
    throw dupErr;
  };

  const raceResult = await ingestVitals({
    patient,
    payload: { readingId: 'r-race', heartRate: 72, spo2: 98, bpSystolic: 120, bpDiastolic: 80 },
  });

  assert.equal(raceResult.duplicate, true);
  assert.equal(raceResult.vitals.readingId, 'r-race');

  Vitals.findOne = originalFindOne;
  Vitals.create = originalCreate;
});

test('Duplicate alert prevention suppresses duplicate active alerts with same dedupKey', async () => {
  const originalFindOne = Alert.findOne;
  const originalCreate = Alert.create;

  const dedupKey = buildDedupKey('pat-1', 'hr_high');
  let createCount = 0;

  Alert.findOne = async (query) => {
    if (query.dedupKey === dedupKey && createCount > 0) {
      return { _id: 'alert-active-1', dedupKey, type: 'hr_high', isAcknowledged: false };
    }
    return null;
  };

  Alert.create = async (doc) => {
    createCount += 1;
    return { ...doc, _id: `alert-${createCount}` };
  };

  try {
    const payload = {
      patient: 'pat-1',
      type: 'hr_high',
      severity: 'critical',
      message: 'Heart rate elevated',
    };

    const first = await createAlert(payload);
    assert.equal(first.created, true);
    assert.equal(first.alert._id, 'alert-1');

    const second = await createAlert(payload);
    assert.equal(second.created, false);
    assert.equal(second.alert._id, 'alert-active-1');
    assert.equal(createCount, 1);
  } finally {
    Alert.findOne = originalFindOne;
    Alert.create = originalCreate;
  }
});

test('No-data, stale, and offline states never report stable or healthy', () => {
  const now = new Date('2026-10-26T12:00:00.000Z').getTime();

  // 1. No data
  const noData = assessVitalsQuality(null, now);
  assert.equal(noData.status, 'no_data');
  assert.equal(noData.isLive, false);
  assert.match(noData.message, /must not be assumed/i);

  // 2. Stale (70 seconds ago > 60s threshold)
  const stale = assessVitalsQuality(
    { observedAt: new Date(now - 70 * 1000) },
    now,
    { staleSeconds: 60, offlineSeconds: 180 }
  );
  assert.equal(stale.status, 'stale');
  assert.equal(stale.isLive, false);
  assert.equal(stale.isStale, true);

  // 3. Offline (200 seconds ago > 180s threshold)
  const offline = assessVitalsQuality(
    { observedAt: new Date(now - 200 * 1000) },
    now,
    { staleSeconds: 60, offlineSeconds: 180 }
  );
  assert.equal(offline.status, 'offline');
  assert.equal(offline.isLive, false);
  assert.equal(offline.isStale, true);
});

test('Full pipeline: temporary outage, buffered accumulation, ordered reconnection replay', async () => {
  const backendReceived = [];
  let backendOnline = false;

  const buffer = new SensorReplayBuffer({
    isOnline: false,
    autoFlush: false,
    ingestFn: async (item) => {
      if (!backendOnline) {
        const err = new Error('Backend outage');
        err.status = 503;
        throw err;
      }
      backendReceived.push(item);
      return { success: true, duplicate: false };
    },
  });

  // Sensor produces 4 readings during backend outage
  buffer.enqueue({ readingId: 'pipe-1', heartRate: 72, deviceTimestamp: '2026-10-26T10:00:00Z', patientId: 'p1' });
  buffer.enqueue({ readingId: 'pipe-2', heartRate: 76, deviceTimestamp: '2026-10-26T10:01:00Z', patientId: 'p1' });
  buffer.enqueue({ readingId: 'pipe-3', heartRate: 80, deviceTimestamp: '2026-10-26T10:02:00Z', patientId: 'p1' });
  buffer.enqueue({ readingId: 'pipe-4', heartRate: 84, deviceTimestamp: '2026-10-26T10:03:00Z', patientId: 'p1' });

  assert.equal(buffer.queue.length, 4);
  assert.equal(backendReceived.length, 0);

  // Attempting flush while offline preserves queue
  await buffer.flush();
  assert.equal(buffer.queue.length, 4);
  assert.equal(backendReceived.length, 0);

  // Backend recovers / reconnection occurs
  backendOnline = true;
  await buffer.setOnline(true);

  assert.equal(buffer.queue.length, 0);
  assert.equal(backendReceived.length, 4);
  assert.deepEqual(
    backendReceived.map((r) => r.readingId),
    ['pipe-1', 'pipe-2', 'pipe-3', 'pipe-4']
  );
  assert.deepEqual(
    backendReceived.map((r) => r.deviceTimestamp),
    [
      '2026-10-26T10:00:00.000Z',
      '2026-10-26T10:01:00.000Z',
      '2026-10-26T10:02:00.000Z',
      '2026-10-26T10:03:00.000Z',
    ]
  );
});
