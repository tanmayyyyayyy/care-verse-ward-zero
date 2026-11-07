'use strict';

const CaregiverShift = require('../models/CaregiverShift');
const User = require('../models/User');
const { Alert } = require('../models/index');

const IDLE_MINUTES = Number(process.env.CAREGIVER_IDLE_MINUTES) || 15;
const UNRESPONSIVE_MINUTES = Number(process.env.CAREGIVER_UNRESPONSIVE_MINUTES) || 45;
const MAX_SHIFT_HOURS = Number(process.env.CAREGIVER_MAX_SHIFT_HOURS) || 12;

const presenceFor = (lastActivityAt, now = Date.now()) => {
  const minutes = (now - new Date(lastActivityAt).getTime()) / 60000;
  if (minutes >= UNRESPONSIVE_MINUTES) return 'unresponsive';
  if (minutes >= IDLE_MINUTES) return 'idle';
  return 'active';
};

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
};

/** Close shifts that were never checked out (forgot to tap "check out"). */
const autoCloseStaleShifts = async (now = Date.now()) => {
  const cutoff = new Date(now - MAX_SHIFT_HOURS * 3600 * 1000);
  const stale = await CaregiverShift.find({ checkOutAt: null, checkInAt: { $lt: cutoff } });
  for (const shift of stale) {
    shift.checkOutAt = new Date(now);
    shift.autoClosed = true;
    await shift.save();
  }
  return stale.length;
};

const getOpenShift = (userId) =>
  CaregiverShift.findOne({
    $or: [{ caregiver: userId }, { user: userId }],
    checkOutAt: null,
    status: { $ne: 'off_duty' },
  });

const checkIn = async (user, patientIds = [], notes = '') => {
  const existing = await getOpenShift(user._id);
  const pList = Array.isArray(patientIds) ? patientIds : patientIds ? [patientIds] : [];
  if (existing) {
    existing.lastActivityAt = new Date();
    existing.status = 'on_duty';
    if (pList.length) {
      existing.patients = pList;
      existing.patient = pList[0];
    }
    if (notes) existing.notes = notes;
    await existing.save();
    return { shift: existing, created: false };
  }
  const shift = await CaregiverShift.create({
    caregiver: user._id,
    user: user._id,
    userName: user.name,
    role: user.role,
    patient: pList[0] || null,
    patients: pList,
    status: 'on_duty',
    notes: notes || '',
  });
  return { shift, created: true };
};

const checkOut = async (user, notes = '') => {
  const shift = await getOpenShift(user._id);
  if (!shift) return null;
  shift.checkOutAt = new Date();
  shift.status = 'off_duty';
  if (notes) shift.notes = shift.notes ? `${shift.notes} | ${notes}` : notes;
  await shift.save();
  return shift;
};

const getOnDutyShifts = async () => {
  await autoCloseStaleShifts();
  return CaregiverShift.find({
    checkOutAt: null,
    status: 'on_duty',
  })
    .populate('caregiver', 'name email role department')
    .populate('patient', 'patientId name bed ward')
    .sort({ checkInAt: -1 });
};

const getCaregiverPerformance = async ({ sinceHours = 24, now = Date.now() } = {}) => {
  const since = new Date(now - sinceHours * 3600 * 1000);
  const [alerts, staff, missedShifts] = await Promise.all([
    Alert.find({
      $or: [
        { isAcknowledged: true, acknowledgedAt: { $gte: since } },
        { isDismissed: true, dismissedAt: { $gte: since } },
        { createdAt: { $gte: since } },
      ],
    }).select('isAcknowledged acknowledgedBy acknowledgmentLatencyMs isDismissed dismissedBy createdAt severity type'),
    User.find({ isActive: { $ne: false }, role: { $in: ['nurse', 'doctor'] } }).select('name role department email'),
    CaregiverShift.find({ status: 'missed', createdAt: { $gte: since } }).select('caregiver user'),
  ]);

  const userLatencyMap = new Map();
  const userHandledCount = new Map();
  const missedCheckinCount = new Map();

  for (const shift of missedShifts) {
    const uid = String(shift.caregiver || shift.user || '');
    if (uid) {
      missedCheckinCount.set(uid, (missedCheckinCount.get(uid) || 0) + 1);
    }
  }

  for (const alert of alerts) {
    if (alert.isAcknowledged && alert.acknowledgedBy) {
      const uid = String(alert.acknowledgedBy);
      userHandledCount.set(uid, (userHandledCount.get(uid) || 0) + 1);
      if (typeof alert.acknowledgmentLatencyMs === 'number' && alert.acknowledgmentLatencyMs >= 0) {
        if (!userLatencyMap.has(uid)) userLatencyMap.set(uid, []);
        userLatencyMap.get(uid).push(alert.acknowledgmentLatencyMs);
      }
    } else if (alert.isDismissed && alert.dismissedBy) {
      const uid = String(alert.dismissedBy);
      userHandledCount.set(uid, (userHandledCount.get(uid) || 0) + 1);
    }
  }

  return staff.map((person) => {
    const uid = String(person._id);
    const latencies = userLatencyMap.get(uid) || [];
    const alertsHandled = userHandledCount.get(uid) || 0;
    const missed = missedCheckinCount.get(uid) || 0;
    const avgAckLatencyMs =
      latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
    const worstAckLatencyMs = latencies.length > 0 ? Math.max(...latencies) : null;

    return {
      caregiverId: uid,
      name: person.name,
      role: person.role,
      department: person.department || '',
      avgAckLatencyMs,
      worstAckLatencyMs,
      alertsHandled,
      missedCheckIns: missed,
      latencySamples: latencies.length,
    };
  });
};

/** Refresh presence after a meaningful action. Never throws: presence must not break clinical flows. */
const recordActivity = async (userId, kind) => {
  try {
    const update = { $set: { lastActivityAt: new Date() } };
    if (['acknowledged', 'dismissed', 'notes'].includes(kind)) {
      update.$inc = { [`activity.${kind}`]: 1 };
    }
    await CaregiverShift.updateOne({ user: userId, checkOutAt: null }, update);
  } catch (error) {
    console.warn('Caregiver activity update failed:', error.message);
  }
};

const countOnDuty = async () => {
  await autoCloseStaleShifts();
  return CaregiverShift.countDocuments({ checkOutAt: null });
};

const getResponseMetrics = async ({ sinceHours = 24, now = Date.now() } = {}) => {
  const since = new Date(now - sinceHours * 3600 * 1000);
  const alerts = await Alert.find({ createdAt: { $gte: since } }).select(
    'isAcknowledged acknowledgedBy acknowledgmentLatencyMs isDismissed resolvedAt createdAt escalationLevel severity'
  );

  const perUser = new Map();
  const latencies = [];
  let unacknowledged = 0;
  let escalated = 0;

  for (const alert of alerts) {
    if (alert.escalationLevel > 0) escalated += 1;
    if (alert.isAcknowledged && alert.acknowledgmentLatencyMs != null) {
      latencies.push(alert.acknowledgmentLatencyMs);
      const key = String(alert.acknowledgedBy || 'unknown');
      if (!perUser.has(key)) perUser.set(key, []);
      perUser.get(key).push(alert.acknowledgmentLatencyMs);
    } else if (!alert.isDismissed && !alert.resolvedAt) {
      unacknowledged += 1;
    }
  }

  return {
    windowHours: sinceHours,
    totalAlerts: alerts.length,
    acknowledged: latencies.length,
    unacknowledged,
    escalated,
    medianResponseMs: median(latencies),
    p90ResponseMs: percentile(latencies, 90),
    byUser: perUser,
  };
};

const getRoster = async ({ now = Date.now() } = {}) => {
  await autoCloseStaleShifts(now);
  const [openShifts, staff, metrics, todaysShifts] = await Promise.all([
    CaregiverShift.find({ checkOutAt: null }).sort({ checkInAt: 1 }),
    User.find({ isActive: { $ne: false }, role: { $in: ['nurse', 'doctor'] } }).select('name role department email'),
    getResponseMetrics({ now }),
    CaregiverShift.find({ checkInAt: { $gte: new Date(now - 24 * 3600 * 1000) } }),
  ]);

  const onDutyIds = new Set(openShifts.map((s) => String(s.user)));
  const hoursOnShift = new Map();
  for (const shift of todaysShifts) {
    const end = shift.checkOutAt ? new Date(shift.checkOutAt).getTime() : now;
    const hours = Math.max(0, (end - new Date(shift.checkInAt).getTime()) / 3600000);
    hoursOnShift.set(String(shift.user), (hoursOnShift.get(String(shift.user)) || 0) + hours);
  }

  const decorate = (person) => {
    const id = String(person._id);
    const shift = openShifts.find((s) => String(s.user) === id) || null;
    const latencies = metrics.byUser.get(id) || [];
    return {
      id,
      name: person.name,
      role: person.role,
      department: person.department || '',
      onDuty: Boolean(shift),
      presence: shift ? presenceFor(shift.lastActivityAt, now) : 'off_duty',
      checkInAt: shift ? shift.checkInAt : null,
      lastActivityAt: shift ? shift.lastActivityAt : null,
      activity: shift ? shift.activity : { acknowledged: 0, dismissed: 0, notes: 0 },
      hoursLast24h: Number((hoursOnShift.get(id) || 0).toFixed(1)),
      responses: latencies.length,
      medianResponseMs: median(latencies),
    };
  };

  const caregivers = staff.map(decorate);
  const onDuty = caregivers.filter((c) => c.onDuty);
  const covered = onDuty.length > 0;

  return {
    generatedAt: new Date(now).toISOString(),
    coverage: {
      onDuty: onDuty.length,
      active: onDuty.filter((c) => c.presence === 'active').length,
      idle: onDuty.filter((c) => c.presence === 'idle').length,
      unresponsive: onDuty.filter((c) => c.presence === 'unresponsive').length,
      covered,
      note: covered
        ? 'At least one staff member is checked in.'
        : 'No staff is checked in. Unacknowledged alerts will escalate beyond the care team.',
    },
    thresholds: { idleMinutes: IDLE_MINUTES, unresponsiveMinutes: UNRESPONSIVE_MINUTES },
    metrics: {
      windowHours: metrics.windowHours,
      totalAlerts: metrics.totalAlerts,
      acknowledged: metrics.acknowledged,
      unacknowledged: metrics.unacknowledged,
      escalated: metrics.escalated,
      medianResponseMs: metrics.medianResponseMs,
      p90ResponseMs: metrics.p90ResponseMs,
    },
    caregivers,
  };
};

module.exports = {
  IDLE_MINUTES,
  UNRESPONSIVE_MINUTES,
  autoCloseStaleShifts,
  checkIn,
  checkOut,
  countOnDuty,
  getCaregiverPerformance,
  getOnDutyShifts,
  getOpenShift,
  getResponseMetrics,
  getRoster,
  median,
  percentile,
  presenceFor,
  recordActivity,
};
