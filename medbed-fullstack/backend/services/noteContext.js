'use strict';

/**
 * Contextual intelligence: turns free-text caregiver notes into structured,
 * explainable context flags.
 *
 * Deliberately a transparent keyword/phrase matcher (not a black-box NLP model):
 *  - every flag names the phrase that triggered it, so a caregiver can see why
 *  - simple negation handling ("no chest pain", "denies dizziness")
 *  - context can only RAISE concern, never lower a vitals-based risk
 *  - reassuring notes are shown but never used to suppress an alert
 *
 * It is a heuristic aid for a prototype, not clinical language understanding.
 */

const LEVELS = Object.freeze({ info: 0, watch: 1, elevated: 2, urgent: 3 });

const RULES = Object.freeze([
  {
    id: 'confusion',
    label: 'New confusion / drowsiness',
    level: 'urgent',
    altersConsciousness: true,
    negatable: true,
    pattern:
      /\b(confus(?:ed|ion)|disorient(?:ed|ation)|drowsy|unresponsive|hard to wake|difficult to wake|not making sense|slurred speech|delirious|incoherent)\b/i,
  },
  {
    id: 'breathing_difficulty',
    label: 'Breathing difficulty',
    level: 'urgent',
    negatable: true,
    pattern:
      /\b(short(?:ness)? of breath|breathless(?:ness)?|struggl\w* to breathe|difficulty breathing|trouble breathing|gasping|wheez\w*|laboured breathing|labored breathing|blue lips)\b/i,
  },
  {
    id: 'chest_pain',
    label: 'Chest pain / pressure',
    level: 'urgent',
    negatable: true,
    pattern: /\bchest\s+(?:pain|pressure|tightness|discomfort)\b/i,
  },
  {
    id: 'fall',
    label: 'Fall reported',
    level: 'urgent',
    negatable: true,
    pattern: /\b(fell|had a fall|a fall|slipped|found on the floor|found on floor|collapsed)\b/i,
  },
  {
    id: 'bleeding',
    label: 'Bleeding',
    level: 'urgent',
    negatable: true,
    pattern: /\b(bleeding|blood in (?:stool|urine|vomit)|nosebleed|bleeds?)\b/i,
  },
  {
    id: 'dizziness',
    label: 'Dizziness / faintness',
    level: 'elevated',
    negatable: true,
    pattern: /\b(dizz(?:y|iness)|light-?headed|faint(?:ing|ed)?|black(?:ed)? out|vertigo)\b/i,
  },
  {
    id: 'vomiting',
    label: 'Vomiting / diarrhoea',
    level: 'elevated',
    negatable: true,
    pattern: /\b(vomit\w*|nausea|nauseous|diarrh\w+|loose stools?)\b/i,
  },
  {
    id: 'pain_worse',
    label: 'Worsening pain',
    level: 'elevated',
    negatable: true,
    pattern: /\b(severe pain|pain (?:is )?(?:worse|worsening|increasing)|worsening pain|unbearable pain)\b/i,
  },
  {
    id: 'poor_intake',
    label: 'Poor food / fluid intake',
    level: 'watch',
    negatable: false,
    pattern:
      /\b(not eating|poor appetite|no appetite|refus(?:ed|ing) (?:food|meals?|water|fluids?)|not drinking|barely drinking|dehydrat\w+)\b/i,
  },
  {
    id: 'missed_medication',
    label: 'Missed / refused medication',
    level: 'watch',
    negatable: false,
    pattern:
      /\b(?:missed|skipped|forgot|refused|refusing)\s+(?:a |the |his |her |their |todays? |morning |evening )?(?:dose|doses|medication|medicine|meds|tablets?|insulin|inhaler)\b/i,
  },
  {
    id: 'swelling',
    label: 'New swelling',
    level: 'watch',
    negatable: true,
    pattern: /\b(swollen|swelling|oedema|edema)\b/i,
  },
  {
    id: 'reassuring',
    label: 'Reassuring note (does not lower risk)',
    level: 'info',
    negatable: false,
    pattern:
      /\b(feeling (?:better|good|well|fine)|comfortable|slept well|ate well|eating well|good appetite|no complaints)\b/i,
  },
]);

const NEGATORS = /\b(no|not|never|denies|denied|without|negative for|free of|nil|absence of)\b[^.;,!?]{0,28}$/i;

const isNegated = (text, matchIndex) => {
  const lookback = text.slice(Math.max(0, matchIndex - 40), matchIndex);
  return NEGATORS.test(lookback);
};

/**
 * @param {string} text single note
 * @returns {Array<{id,label,level,phrase,altersConsciousness}>}
 */
const analyzeNote = (text) => {
  const clean = String(text || '').slice(0, 2000);
  if (!clean.trim()) return [];

  const found = [];
  for (const rule of RULES) {
    const flags = new RegExp(rule.pattern.source, 'ig');
    let match;
    while ((match = flags.exec(clean)) !== null) {
      if (rule.negatable && isNegated(clean, match.index)) continue;
      found.push({
        id: rule.id,
        label: rule.label,
        level: rule.level,
        phrase: match[0],
        altersConsciousness: Boolean(rule.altersConsciousness),
      });
      break; // one hit per rule per note is enough for explanation
    }
  }
  return found;
};

const highestLevel = (flags) =>
  flags.reduce(
    (best, flag) => (LEVELS[flag.level] > LEVELS[best] ? flag.level : best),
    'info'
  );

/**
 * Aggregate recent notes into one context summary.
 * @param {Array<{text,createdAt,authorName}>} notes
 * @param {object} [options]
 * @param {number} [options.windowHours=24] only notes within window influence risk
 * @param {number} [options.now]
 */
const summarizeContext = (notes = [], { windowHours = 24, now = Date.now() } = {}) => {
  const cutoff = now - windowHours * 3600 * 1000;
  const flagMap = new Map();
  const analyzed = [];

  for (const note of notes) {
    const createdAt = new Date(note.createdAt || now).getTime();
    const inWindow = createdAt >= cutoff;
    const flags = analyzeNote(note.text);
    analyzed.push({ ...note, flags, inWindow });
    if (!inWindow) continue;
    for (const flag of flags) {
      const existing = flagMap.get(flag.id);
      if (!existing || createdAt > existing.at) {
        flagMap.set(flag.id, { ...flag, at: createdAt, author: note.authorName || '' });
      }
    }
  }

  const activeFlags = [...flagMap.values()].sort(
    (a, b) => LEVELS[b.level] - LEVELS[a.level] || b.at - a.at
  );
  const concerning = activeFlags.filter((flag) => flag.level !== 'info');
  const level = concerning.length ? highestLevel(concerning) : 'none';
  const alterConsciousness = concerning.some((flag) => flag.altersConsciousness);

  let minimumRisk = 'low';
  if (level === 'urgent') minimumRisk = 'high';
  else if (level === 'elevated' || concerning.filter((f) => f.level === 'watch').length >= 2) {
    minimumRisk = 'medium';
  }

  const summary = concerning.length
    ? `Caregiver notes (last ${windowHours}h) mention: ${concerning
        .map((flag) => `${flag.label.toLowerCase()} ("${flag.phrase}")`)
        .join('; ')}.`
    : `No concerning caregiver-note findings in the last ${windowHours}h.`;

  return {
    level,
    minimumRisk,
    alterConsciousness,
    flags: activeFlags,
    summary,
    analyzedNotes: analyzed,
    windowHours,
  };
};

module.exports = { LEVELS, RULES, analyzeNote, summarizeContext };
