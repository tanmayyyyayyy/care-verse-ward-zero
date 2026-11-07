'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { analyzeNote, summarizeContext, RULES } = require('../services/noteContext');
const { ruleTrendFallback } = require('../services/trendPredictionService');

test('Feature 3: Configurable symptom rules file exists and is valid JSON', () => {
  const cfgPath = path.join(__dirname, '../config/symptomRules.json');
  assert(fs.existsSync(cfgPath), 'symptomRules.json must exist');
  const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert(Array.isArray(parsed.rules), 'symptomRules.json must define a rules array');
  assert(parsed.rules.length >= 8, 'symptomRules.json must define core clinical symptom rules');

  const ruleIds = parsed.rules.map((r) => r.id);
  assert(ruleIds.includes('dizziness'), 'Must include dizziness rule');
  assert(ruleIds.includes('breathing_difficulty'), 'Must include breathlessness / breathing_difficulty rule');
  assert(ruleIds.includes('reduced_intake'), 'Must include reduced_intake rule');
  assert(ruleIds.includes('confusion'), 'Must include confusion rule');
  assert(ruleIds.includes('missed_medication'), 'Must include missed_medication rule');
  assert(ruleIds.includes('fall'), 'Must include fall rule');
});

test('Feature 3: Rule extractor accurately detects core symptoms and tags extractor label', () => {
  const note1 = 'Patient experienced sudden dizziness when standing up and looked unsteady.';
  const flags1 = analyzeNote(note1);
  assert(flags1.some((f) => f.id === 'dizziness' && f.level === 'elevated'));
  assert.equal(flags1[0].extractor, 'rule', 'Extractor must be explicitly labeled as rule');

  const note2 = 'Caregiver noted shortness of breath and wheezing after light exertion.';
  const flags2 = analyzeNote(note2);
  assert(flags2.some((f) => f.id === 'breathing_difficulty' && f.level === 'urgent'));

  const note3 = 'Patient had a fall near bathroom at 3am; found on floor.';
  const flags3 = analyzeNote(note3);
  assert(flags3.some((f) => f.id === 'fall' && f.level === 'urgent'));

  const note4 = 'Reduced intake today, refused food and only had a few sips of water. Also missed morning medication.';
  const flags4 = analyzeNote(note4);
  assert(flags4.some((f) => f.id === 'reduced_intake' && f.level === 'watch'));
  assert(flags4.some((f) => f.id === 'missed_medication' && f.level === 'watch'));
});

test('Feature 3: Negation handling prevents false positive symptom extraction', () => {
  const negatedNote1 = 'Patient denies dizziness and denies shortness of breath. No chest pain.';
  const flags1 = analyzeNote(negatedNote1).filter((f) => f.level !== 'info');
  assert.equal(flags1.length, 0, 'Negated symptoms must not produce acute flags');

  const negatedNote2 = 'Negative for confusion, without any difficulty breathing.';
  const flags2 = analyzeNote(negatedNote2).filter((f) => f.level !== 'info');
  assert.equal(flags2.length, 0, 'Negated confusion and breathing difficulty must not produce acute flags');
});

test('Feature 3: Reassuring notes can never lower or clear an elevated risk', () => {
  const reassuringNote = 'Patient is feeling much better today, ate well and slept comfortably.';
  const flags = analyzeNote(reassuringNote);
  assert(flags.some((f) => f.id === 'reassuring' && f.level === 'info'));

  const context = summarizeContext([{ text: reassuringNote, createdAt: new Date() }]);
  assert.equal(context.minimumRisk, 'low');
  // Reassuring context minimumRisk must never suppress or downgrade high/urgent vitals risk
  assert.equal(context.level, 'none', 'Reassuring notes do not produce concerning escalation');
});

test('Feature 3: Urgent note sets high risk floor and explains attribution', () => {
  const urgentNotes = [
    { text: 'Patient disoriented and confused, not making sense when spoken to.', createdAt: new Date() },
  ];
  const context = summarizeContext(urgentNotes);
  assert.equal(context.level, 'urgent');
  assert.equal(context.minimumRisk, 'high', 'Urgent note must enforce high risk floor');
  assert.equal(context.alterConsciousness, true);
  assert.match(context.summary, /confusion/i);
});
