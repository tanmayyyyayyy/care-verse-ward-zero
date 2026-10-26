const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * SensorReplayBuffer
 *
 * Minimal reliable buffer for sensor readings during network/backend outages.
 *
 * Guarantees and Design:
 * - Order preservation: FIFO queue drains strictly in observation sequence.
 * - Timestamp and ID preservation: readingId and original deviceTimestamp are preserved.
 * - Transient failure retry: bounded exponential backoff with configurable initial and max delays.
 * - Duplicate prevention: idempotent readingId ensures backend does not duplicate records or alerts.
 * - Late reading handling: out-of-order readings are marked isLate on backend and cannot overwrite
 *   the latest valid measurement or create misleading active alerts.
 * - Permanent failure handling: non-retriable validation failures (e.g. 400 Bad Request, 422) are
 *   moved to a dead-letter queue so they do not block the FIFO queue indefinitely.
 * - Durability: If storagePath is specified, the queue is persisted to disk on every change.
 *   If storagePath is null/omitted, the queue operates in-memory; queued readings are lost on process restart.
 */
class SensorReplayBuffer {
  constructor(options = {}) {
    this.storagePath = options.storagePath || null;
    this.initialBackoffMs = options.initialBackoffMs ?? 100;
    this.maxBackoffMs = options.maxBackoffMs ?? 5000;
    this.backoffMultiplier = options.backoffMultiplier ?? 2;
    this.ingestFn = options.ingestFn || null;
    this.isOnline = options.isOnline !== undefined ? Boolean(options.isOnline) : true;
    this.autoFlush = options.autoFlush !== undefined ? Boolean(options.autoFlush) : true;

    this.queue = [];
    this.deadLetterQueue = [];
    this.totalEnqueued = 0;
    this.totalReplayed = 0;
    this.totalDuplicates = 0;
    this.totalDeadLettered = 0;
    this.isReplaying = false;
    this.activeFlushPromise = null;
    this.transientFailures = 0;
    this.currentBackoffMs = 0;
    this.lastError = null;
    this.lastReplayAt = null;
    this.retryTimer = null;

    if (this.storagePath) {
      this._loadFromDisk();
    }
  }

  _loadFromDisk() {
    try {
      if (fs.existsSync(this.storagePath)) {
        const raw = fs.readFileSync(this.storagePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.queue)) this.queue = parsed.queue;
        if (Array.isArray(parsed.deadLetterQueue)) this.deadLetterQueue = parsed.deadLetterQueue;
        this.totalEnqueued = parsed.totalEnqueued || this.queue.length;
        this.totalReplayed = parsed.totalReplayed || 0;
        this.totalDuplicates = parsed.totalDuplicates || 0;
        this.totalDeadLettered = parsed.totalDeadLettered || this.deadLetterQueue.length;
      }
    } catch (err) {
      this.lastError = `Failed to load persisted buffer: ${err.message}`;
    }
  }

  _persistToDisk() {
    if (!this.storagePath) return;
    try {
      const dir = path.dirname(this.storagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        queue: this.queue,
        deadLetterQueue: this.deadLetterQueue,
        totalEnqueued: this.totalEnqueued,
        totalReplayed: this.totalReplayed,
        totalDuplicates: this.totalDuplicates,
        totalDeadLettered: this.totalDeadLettered,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.storagePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      this.lastError = `Failed to persist buffer: ${err.message}`;
    }
  }

  enqueue(reading) {
    if (!reading || typeof reading !== 'object') {
      throw new Error('Invalid reading payload: object expected');
    }

    const deviceTimestamp = reading.deviceTimestamp
      ? new Date(reading.deviceTimestamp).toISOString()
      : new Date().toISOString();

    const readingId = String(
      reading.readingId || `buf-${crypto.randomUUID()}`
    );

    const queuedItem = {
      ...reading,
      readingId,
      deviceTimestamp,
      observedAt: reading.observedAt || deviceTimestamp,
      enqueuedAt: new Date().toISOString(),
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
    };

    this.queue.push(queuedItem);
    this.totalEnqueued += 1;
    this._persistToDisk();

    if (this.isOnline && this.autoFlush && !this.activeFlushPromise) {
      this.flush().catch((err) => {
        this.lastError = err.message;
      });
    }

    return queuedItem;
  }

  isPermanentFailure(error) {
    if (!error) return false;
    const status = error.status || error.statusCode || error.response?.status;
    if (status === 400 || status === 404 || status === 422) return true;
    if (error.isPermanent === true) return true;
    if (error.name === 'ValidationError') return true;
    const msg = String(error.message || '').toLowerCase();
    if (msg.includes('greater than diastolic') || msg.includes('validation failed')) {
      return true;
    }
    return false;
  }

  async flush() {
    if (this.activeFlushPromise) {
      return this.activeFlushPromise;
    }

    const run = async () => {
      if (!this.isOnline || this.queue.length === 0) {
        return this.getStatus();
      }
      if (!this.ingestFn) {
        this.lastError = 'No ingestFn configured on replay buffer';
        return this.getStatus();
      }

      this.isReplaying = true;

      try {
        while (this.queue.length > 0 && this.isOnline) {
          const item = this.queue[0];
          item.attempts += 1;
          item.lastAttemptAt = new Date().toISOString();

          try {
            const result = await this.ingestFn(item);

            if (result && result.duplicate) {
              this.totalDuplicates += 1;
            } else {
              this.totalReplayed += 1;
            }

            this.queue.shift();
            this.transientFailures = 0;
            this.currentBackoffMs = 0;
            this.lastReplayAt = new Date().toISOString();
            this._persistToDisk();
          } catch (error) {
            item.lastError = error.message;

            if (this.isPermanentFailure(error)) {
              this.queue.shift();
              this.deadLetterQueue.push({
                reading: item,
                rejectedAt: new Date().toISOString(),
                error: error.message,
                attempts: item.attempts,
              });
              this.totalDeadLettered += 1;
              this.lastError = `Permanent failure: ${error.message}`;
              this._persistToDisk();
              // Continue processing next items in queue
              continue;
            }

            // Transient failure (network/server/db down)
            this.transientFailures += 1;
            this.lastError = error.message;
            const exponent = Math.max(0, this.transientFailures - 1);
            const delay = Math.min(
              this.maxBackoffMs,
              this.initialBackoffMs * Math.pow(this.backoffMultiplier, exponent)
            );
            this.currentBackoffMs = delay;

            if (this.isOnline) {
              if (this.retryTimer) clearTimeout(this.retryTimer);
              this.retryTimer = setTimeout(() => {
                this.retryTimer = null;
                this.flush();
              }, delay);
            }

            // Preserving FIFO order: do not pop the failed item, break loop
            break;
          }
        }
      } finally {
        this.isReplaying = false;
      }

      return this.getStatus();
    };

    this.activeFlushPromise = run().finally(() => {
      this.activeFlushPromise = null;
    });

    return this.activeFlushPromise;
  }

  async setOnline(online) {
    const nextState = Boolean(online);
    const wasOffline = !this.isOnline;
    this.isOnline = nextState;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (nextState && wasOffline) {
      this.transientFailures = 0;
      this.currentBackoffMs = 0;
      return this.flush();
    }

    return this.getStatus();
  }

  clear() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.queue = [];
    this.deadLetterQueue = [];
    this.totalEnqueued = 0;
    this.totalReplayed = 0;
    this.totalDuplicates = 0;
    this.totalDeadLettered = 0;
    this.transientFailures = 0;
    this.currentBackoffMs = 0;
    this.lastError = null;
    this.activeFlushPromise = null;
    if (this.storagePath && fs.existsSync(this.storagePath)) {
      try {
        fs.unlinkSync(this.storagePath);
      } catch {
        // ignore
      }
    }
  }

  getStatus() {
    return {
      connectivity: this.isOnline ? 'online' : 'offline',
      isOnline: this.isOnline,
      isReplaying: this.isReplaying,
      queueLength: this.queue.length,
      deadLetterCount: this.deadLetterQueue.length,
      totalEnqueued: this.totalEnqueued,
      totalReplayed: this.totalReplayed,
      totalDuplicates: this.totalDuplicates,
      totalDeadLettered: this.totalDeadLettered,
      lastReplayAt: this.lastReplayAt,
      lastError: this.lastError,
      backoffDelayMs: this.currentBackoffMs,
      isDurable: Boolean(this.storagePath),
      storageNotice: this.storagePath
        ? `Durable queue persisted to ${this.storagePath}`
        : 'In-memory queue only; queued readings are lost on process restart',
    };
  }
}

module.exports = { SensorReplayBuffer };
