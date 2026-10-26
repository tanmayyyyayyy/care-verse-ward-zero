const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SensorReplayBuffer } = require('../services/sensorReplayBuffer');

test('SensorReplayBuffer preserves reading IDs, order, and device timestamps', async () => {
  const dispatched = [];
  const buffer = new SensorReplayBuffer({
    isOnline: false,
    ingestFn: async (item) => {
      dispatched.push(item);
      return { success: true, duplicate: false };
    },
  });

  const t1 = '2026-10-26T10:00:00.000Z';
  const t2 = '2026-10-26T10:01:00.000Z';
  const t3 = '2026-10-26T10:02:00.000Z';

  buffer.enqueue({ readingId: 'r-001', deviceTimestamp: t1, heartRate: 75, spo2: 98, patientId: 'p1' });
  buffer.enqueue({ readingId: 'r-002', deviceTimestamp: t2, heartRate: 80, spo2: 97, patientId: 'p1' });
  buffer.enqueue({ readingId: 'r-003', deviceTimestamp: t3, heartRate: 85, spo2: 96, patientId: 'p1' });

  assert.equal(buffer.queue.length, 3);
  assert.equal(dispatched.length, 0);

  // Reconnect / go online and await flush
  await buffer.setOnline(true);

  assert.equal(dispatched.length, 3);
  assert.equal(dispatched[0].readingId, 'r-001');
  assert.equal(dispatched[0].deviceTimestamp, t1);
  assert.equal(dispatched[1].readingId, 'r-002');
  assert.equal(dispatched[1].deviceTimestamp, t2);
  assert.equal(dispatched[2].readingId, 'r-003');
  assert.equal(dispatched[2].deviceTimestamp, t3);
  assert.equal(buffer.queue.length, 0);
  assert.equal(buffer.getStatus().totalReplayed, 3);
});

test('SensorReplayBuffer retries transient failures with bounded exponential backoff', async () => {
  let callCount = 0;
  const buffer = new SensorReplayBuffer({
    initialBackoffMs: 20,
    maxBackoffMs: 80,
    backoffMultiplier: 2,
    isOnline: true,
    autoFlush: false,
    ingestFn: async (item) => {
      callCount += 1;
      if (callCount < 3) {
        const transientErr = new Error('ECONNREFUSED: server unavailable');
        transientErr.status = 503;
        throw transientErr;
      }
      return { success: true, duplicate: false };
    },
  });

  buffer.enqueue({ readingId: 'r-retry', heartRate: 72, patientId: 'p1' });
  await buffer.flush();

  // First attempt fails immediately, backoff scheduled
  assert.equal(buffer.queue.length, 1);
  assert.equal(buffer.transientFailures, 1);
  assert.equal(buffer.currentBackoffMs, 20);

  // Wait for backoff retries to succeed
  await new Promise((resolve) => setTimeout(resolve, 200));

  assert.equal(callCount >= 3, true);
  assert.equal(buffer.queue.length, 0);
  assert.equal(buffer.getStatus().totalReplayed, 1);
  assert.equal(buffer.currentBackoffMs, 0);
});

test('SensorReplayBuffer dead-letters permanent validation failures without blocking queue', async () => {
  const processed = [];
  const buffer = new SensorReplayBuffer({
    isOnline: true,
    autoFlush: false,
    ingestFn: async (item) => {
      if (item.bpSystolic <= item.bpDiastolic) {
        const valError = new Error('Systolic blood pressure must be greater than diastolic');
        valError.status = 400;
        throw valError;
      }
      processed.push(item.readingId);
      return { success: true, duplicate: false };
    },
  });

  // Enqueue invalid reading first, then valid reading
  buffer.enqueue({ readingId: 'r-bad', bpSystolic: 80, bpDiastolic: 120, patientId: 'p1' });
  buffer.enqueue({ readingId: 'r-good', bpSystolic: 120, bpDiastolic: 80, patientId: 'p1' });

  await buffer.flush();

  assert.equal(buffer.queue.length, 0);
  assert.equal(buffer.deadLetterQueue.length, 1);
  assert.equal(buffer.deadLetterQueue[0].reading.readingId, 'r-bad');
  assert.match(buffer.deadLetterQueue[0].error, /greater than diastolic/i);
  assert.deepEqual(processed, ['r-good']);
  assert.equal(buffer.getStatus().totalDeadLettered, 1);
  assert.equal(buffer.getStatus().totalReplayed, 1);
});

test('SensorReplayBuffer handles duplicate response safely', async () => {
  const buffer = new SensorReplayBuffer({
    isOnline: true,
    autoFlush: false,
    ingestFn: async () => ({ duplicate: true, message: 'Duplicate reading ignored' }),
  });

  buffer.enqueue({ readingId: 'r-dup', heartRate: 74, patientId: 'p1' });
  await buffer.flush();

  assert.equal(buffer.queue.length, 0);
  assert.equal(buffer.getStatus().totalDuplicates, 1);
  assert.equal(buffer.getStatus().totalReplayed, 0);
});

test('SensorReplayBuffer persists queue to disk when storagePath is configured', () => {
  const tempPath = path.join(os.tmpdir(), `replay-test-${Date.now()}.json`);
  try {
    const buffer1 = new SensorReplayBuffer({
      storagePath: tempPath,
      isOnline: false,
      ingestFn: async () => ({ success: true }),
    });

    buffer1.enqueue({ readingId: 'r-persisted-1', heartRate: 70, patientId: 'p1' });
    buffer1.enqueue({ readingId: 'r-persisted-2', heartRate: 72, patientId: 'p1' });

    assert.equal(fs.existsSync(tempPath), true);

    // Instantiate new buffer from same storagePath (simulating process restart)
    const buffer2 = new SensorReplayBuffer({
      storagePath: tempPath,
      isOnline: false,
    });

    assert.equal(buffer2.queue.length, 2);
    assert.equal(buffer2.queue[0].readingId, 'r-persisted-1');
    assert.equal(buffer2.queue[1].readingId, 'r-persisted-2');
    assert.equal(buffer2.getStatus().isDurable, true);
    assert.match(buffer2.getStatus().storageNotice, /Durable queue persisted/);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
});

test('SensorReplayBuffer documents in-memory restart limitation when storagePath is absent', () => {
  const buffer = new SensorReplayBuffer();
  const status = buffer.getStatus();
  assert.equal(status.isDurable, false);
  assert.match(status.storageNotice, /In-memory queue only; queued readings are lost on process restart/);
});
