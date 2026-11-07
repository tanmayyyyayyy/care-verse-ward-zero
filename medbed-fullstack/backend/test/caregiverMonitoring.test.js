'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const CaregiverShift = require('../models/CaregiverShift');
const Patient = require('../models/Patient');
const { Alert } = require('../models/index');
const caregiverService = require('../services/caregiverService');
const { runMissedCheckinMonitor, runEscalationCycle } = require('../services/patientMonitorService');

test('CaregiverShift model: pre-validation synchronizes caregiver/user and patient/patients', async () => {
  const shift = new CaregiverShift({
    caregiver: '650000000000000000000001',
    patient: '650000000000000000000002',
    notes: 'Morning home check',
  });
  await shift.validate();

  assert.equal(String(shift.user), '650000000000000000000001');
  assert.equal(String(shift.caregiver), '650000000000000000000001');
  assert.equal(shift.status, 'on_duty');
  assert.equal(shift.patients.length, 1);
  assert.equal(String(shift.patients[0]), '650000000000000000000002');
});

test('caregiverService.checkIn & checkOut transitions', async () => {
  const originalFindOne = CaregiverShift.findOne;
  const originalCreate = CaregiverShift.create;

  let activeShift = null;

  CaregiverShift.findOne = async () => activeShift;
  CaregiverShift.create = async (doc) => {
    activeShift = {
      _id: 'shift-123',
      ...doc,
      save: async function () { return this; },
    };
    return activeShift;
  };

  try {
    const user = { _id: 'user-cg-1', name: 'Nurse Priya', role: 'nurse' };
    const { shift, created } = await caregiverService.checkIn(user, ['pat-1'], 'Starting shift');
    assert.equal(created, true);
    assert.equal(shift.status, 'on_duty');
    assert.equal(String(shift.caregiver), 'user-cg-1');

    // Calling checkIn again updates the existing shift
    const repeat = await caregiverService.checkIn(user, ['pat-1', 'pat-2'], 'Updated shift');
    assert.equal(repeat.created, false);
    assert.equal(repeat.shift.notes, 'Updated shift');

    // Check out
    const checkedOut = await caregiverService.checkOut(user, 'All vitals normal');
    assert.ok(checkedOut);
    assert.equal(checkedOut.status, 'off_duty');
    assert.ok(checkedOut.checkOutAt instanceof Date);
  } finally {
    CaregiverShift.findOne = originalFindOne;
    CaregiverShift.create = originalCreate;
  }
});

test('caregiverService.getCaregiverPerformance computes latency, alerts handled, and missed check-ins', async () => {
  const originalAlertFind = Alert.find;
  const originalShiftFind = CaregiverShift.find;
  const User = require('../models/User');
  const originalUserFind = User.find;

  const mockStaff = [
    { _id: 'cg-1', name: 'Caregiver Priya', role: 'nurse', department: 'Home Care' },
    { _id: 'cg-2', name: 'Caregiver Ravi', role: 'nurse', department: 'Home Care' },
  ];

  const mockAlerts = [
    {
      isAcknowledged: true,
      acknowledgedBy: 'cg-1',
      acknowledgmentLatencyMs: 1200,
    },
    {
      isAcknowledged: true,
      acknowledgedBy: 'cg-1',
      acknowledgmentLatencyMs: 4800,
    },
    {
      isDismissed: true,
      dismissedBy: 'cg-1',
    },
    {
      isAcknowledged: true,
      acknowledgedBy: 'cg-2',
      acknowledgmentLatencyMs: 3000,
    },
  ];

  const mockMissedShifts = [
    { caregiver: 'cg-2', user: 'cg-2', status: 'missed' },
  ];

  Alert.find = () => ({
    select: async () => mockAlerts,
  });

  CaregiverShift.find = () => ({
    select: async () => mockMissedShifts,
  });

  User.find = () => ({
    select: async () => mockStaff,
  });

  try {
    const perf = await caregiverService.getCaregiverPerformance({ sinceHours: 24 });
    assert.equal(perf.length, 2);

    const priya = perf.find((p) => p.caregiverId === 'cg-1');
    assert.ok(priya);
    // (1200 + 4800) / 2 = 3000
    assert.equal(priya.avgAckLatencyMs, 3000);
    assert.equal(priya.worstAckLatencyMs, 4800);
    // 2 acks + 1 dismiss = 3
    assert.equal(priya.alertsHandled, 3);
    assert.equal(priya.missedCheckIns, 0);

    const ravi = perf.find((p) => p.caregiverId === 'cg-2');
    assert.ok(ravi);
    assert.equal(ravi.avgAckLatencyMs, 3000);
    assert.equal(ravi.worstAckLatencyMs, 3000);
    assert.equal(ravi.alertsHandled, 1);
    assert.equal(ravi.missedCheckIns, 1);
  } finally {
    Alert.find = originalAlertFind;
    CaregiverShift.find = originalShiftFind;
    User.find = originalUserFind;
  }
});

test('runMissedCheckinMonitor creates caregiver_missed_checkin alert when absent beyond timeout', async () => {
  const originalPatientFind = Patient.find;
  const originalShiftFindOne = CaregiverShift.findOne;
  const originalAlertFindOne = Alert.findOne;
  const originalAlertCreate = Alert.create;

  const mockPatients = [
    {
      _id: 'pat-101',
      patientId: 'PT-101',
      name: 'Synthetic Patient Alice',
      assignedCaregiver: 'cg-priya',
      assignedDoctor: 'doc-asha',
      isActive: true,
      createdAt: new Date(Date.now() - 4000 * 1000),
    },
  ];

  Patient.find = () => ({
    select: async () => mockPatients,
  });

  // No on_duty shift, and last shift check-out was 3600 seconds ago (> 1800s timeout)
  CaregiverShift.findOne = (query) => {
    if (query.status === 'on_duty') return Promise.resolve(null);
    return {
      sort: () => Promise.resolve({
        checkInAt: new Date(Date.now() - 7200 * 1000),
        checkOutAt: new Date(Date.now() - 3600 * 1000),
      }),
    };
  };

  let alertCreated = null;
  Alert.findOne = async () => null; // No dedup match
  Alert.create = async (payload) => {
    alertCreated = payload;
    return payload;
  };

  try {
    const createdList = await runMissedCheckinMonitor(null, Date.now());
    assert.equal(createdList.length, 1);
    assert.ok(alertCreated);
    assert.equal(alertCreated.type, 'caregiver_missed_checkin');
    assert.equal(alertCreated.severity, 'warning');
    assert.equal(alertCreated.assignedTo, 'cg-priya');
    assert.ok(alertCreated.message.includes('missed check-in'));
  } finally {
    Patient.find = originalPatientFind;
    CaregiverShift.findOne = originalShiftFindOne;
    Alert.findOne = originalAlertFindOne;
    Alert.create = originalAlertCreate;
  }
});

test('runEscalationCycle routes strictly: assignedCaregiver -> doctor -> admin without clinical transfer', async () => {
  const originalAlertFind = Alert.find;
  const originalPatientFindById = Patient.findById;

  const mockAlert = {
    _id: 'alert-esc-1',
    patient: 'pat-101',
    createdAt: new Date(Date.now() - 700 * 1000), // > 2 * 300s
    escalationLevel: 0,
    assignedTo: 'cg-priya',
    escalationHistory: [],
    save: async function () { return this; },
  };

  Alert.find = () => Promise.resolve([mockAlert]);
  Patient.findById = () => ({
    select: async () => ({
      _id: 'pat-101',
      assignedDoctor: 'doc-asha',
      assignedCaregiver: 'cg-priya',
    }),
  });

  try {
    // Escalate L0 -> L1 (caregiver -> doctor)
    const escalated = await runEscalationCycle(null, Date.now());
    assert.equal(escalated.length, 1);
    assert.equal(mockAlert.escalationLevel, 1);
    assert.equal(mockAlert.assignedTo, 'doc-asha');
    assert.equal(mockAlert.escalationHistory.length, 1);
    assert.equal(mockAlert.escalationHistory[0].toRole, 'doctor');
  } finally {
    Alert.find = originalAlertFind;
    Patient.findById = originalPatientFindById;
  }
});
