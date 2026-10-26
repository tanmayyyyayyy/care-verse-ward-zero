const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const User = require('../models/User');
const Patient = require('../models/Patient');
const Vitals = require('../models/Vitals');

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'WardZero!2026';

const users = [
  { name: 'Ward Zero Admin', email: 'admin@careverse.com', role: 'admin', department: 'Operations' },
  { name: 'Dr. Asha Rao', email: 'doctor@careverse.com', role: 'doctor', department: 'Critical Care' },
  { name: 'Nurse Ravi Kumar', email: 'nurse@careverse.com', role: 'nurse', department: 'Ward Zero' },
];

const patients = [
  {
    patientId: 'WZ-1001',
    name: 'Synthetic Patient A',
    age: 72,
    gender: 'male',
    ward: 'Ward Zero',
    bed: 'Z-01',
    condition: 'cardiac',
    diagnosis: 'Synthetic post-operative cardiac monitoring',
    isPostSurgery: true,
    riskLevel: 'medium',
    riskScore: 45,
    vitals: { heartRate: 92, spo2: 95, bpSystolic: 138, bpDiastolic: 84, temperature: 37.2, respiratoryRate: 18 },
  },
  {
    patientId: 'WZ-1002',
    name: 'Synthetic Patient B',
    age: 64,
    gender: 'female',
    ward: 'Ward Zero',
    bed: 'Z-02',
    condition: 'respiratory',
    diagnosis: 'Synthetic respiratory monitoring',
    isPostSurgery: false,
    riskLevel: 'low',
    riskScore: 20,
    vitals: { heartRate: 78, spo2: 98, bpSystolic: 122, bpDiastolic: 78, temperature: 36.8, respiratoryRate: 16 },
  },
  {
    patientId: 'WZ-1003',
    name: 'Synthetic Patient C',
    age: 81,
    gender: 'female',
    ward: 'Ward Zero',
    bed: 'Z-03',
    condition: 'hydrocephalus',
    diagnosis: 'Synthetic neuro observation',
    isPostSurgery: true,
    riskLevel: 'high',
    riskScore: 70,
    vitals: { heartRate: 104, spo2: 93, bpSystolic: 148, bpDiastolic: 88, temperature: 37.5, respiratoryRate: 21 },
  },
  {
    patientId: 'WZ-1004',
    name: 'Synthetic Patient D',
    age: 58,
    gender: 'male',
    ward: 'Ward Zero',
    bed: 'Z-04',
    condition: 'orthopaedic',
    diagnosis: 'Synthetic post-fall observation',
    isPostSurgery: false,
    riskLevel: 'medium',
    riskScore: 40,
    vitals: { heartRate: 86, spo2: 96, bpSystolic: 130, bpDiastolic: 82, temperature: 36.9, respiratoryRate: 17 },
  },
];

const main = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not set. Seed from medbed-fullstack/backend with a valid .env.');
  }

  await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const savedUsers = {};

  for (const entry of users) {
    const user = await User.findOneAndUpdate(
      { email: entry.email },
      { ...entry, password: passwordHash, isActive: true },
      { upsert: true, new: true, runValidators: false }
    );
    savedUsers[entry.role] = user;
    console.log(`Seeded ${entry.role}: ${entry.email}`);
  }

  for (const entry of patients) {
    const { vitals, ...patientData } = entry;
    const patient = await Patient.findOneAndUpdate(
      { patientId: entry.patientId },
      {
        ...patientData,
        assignedDoctor: savedUsers.doctor._id,
        isActive: true,
      },
      { upsert: true, new: true, runValidators: true }
    );

    const readingId = `seed-${patient.patientId}-baseline`;
    const exists = await Vitals.findOne({ patient: patient._id, readingId });
    if (!exists) {
      const now = new Date();
      await Vitals.create({
        patient: patient._id,
        readingId,
        deviceId: `SEED-${patient.bed}`,
        ...vitals,
        predictedRisk: patient.riskLevel,
        aiFlags: { hrAlert: false, spo2Alert: false, bpAlert: false },
        assessmentSource: 'fallback',
        assessmentExplanation:
          'Seeded demo baseline. No live AI call was made for this baseline reading.',
        fallbackReason: 'Seeded baseline reading.',
        deviceTimestamp: now,
        observedAt: now,
        receivedAt: now,
        recordedAt: now,
        source: 'simulation',
      });
    }

    console.log(`Seeded patient: ${patient.patientId} ${patient.name}`);
  }

  console.log(`\nDemo login password for all seeded accounts: ${DEMO_PASSWORD}`);
  console.log('These are synthetic demo accounts. Change or remove them before any real deployment.');
};

main()
  .then(async () => {
    await mongoose.connection.close();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('Seed failed:', error.message);
    await mongoose.connection.close().catch(() => {});
    process.exit(1);
  });
