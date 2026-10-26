// backend/services/aiService.js
// Bridges Node backend → Python AI microservice
// Falls back to rule-based logic if Python service is unavailable

const axios = require('axios');

const DEFAULT_AI_URL = process.env.AI_SERVICE_URL || 'http://localhost:8000';
const DEFAULT_TIMEOUT_MS = 3000;
const HEALTH_TIMEOUT_MS = 1500;
const RISK_LEVELS = new Set(['low', 'medium', 'high']);

const AI_REQUEST_FIELDS = Object.freeze({
  heartRate: 'heart_rate',
  spo2: 'spo2',
  bpSystolic: 'bp_systolic',
  bpDiastolic: 'bp_diastolic',
  age: 'age',
  condition: 'condition',
  isPostSurgery: 'is_post_surgery',
});

const AI_RESPONSE_FLAG_FIELDS = Object.freeze({
  hr_alert: 'hrAlert',
  spo2_alert: 'spo2Alert',
  bp_alert: 'bpAlert',
});

const toAiRequest = (input = {}) => {
  const data = input && typeof input === 'object' ? input : {};
  const payload = {};

  Object.entries(AI_REQUEST_FIELDS).forEach(([nodeField, aiField]) => {
    if (data[nodeField] !== undefined) payload[aiField] = data[nodeField];
  });

  if (payload.is_post_surgery !== undefined) {
    payload.is_post_surgery = Boolean(payload.is_post_surgery);
  }

  return payload;
};

const describeAiError = (error) => {
  const status = error?.response?.status;

  if (status) return `AI service returned HTTP ${status}`;
  if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
    return 'AI service request timed out';
  }
  if (error?.code === 'ECONNREFUSED') {
    return 'AI service unavailable (connection refused)';
  }

  return error?.message || 'AI service unavailable';
};

const normalizeAiResponse = (data) => {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('AI response was not a JSON object');
  }

  if (!RISK_LEVELS.has(data.risk)) {
    throw new Error(`AI response contained an invalid risk level: ${String(data.risk)}`);
  }

  if (typeof data.score !== 'number' || !Number.isFinite(data.score)) {
    throw new Error('AI response contained an invalid score');
  }

  if (!data.flags || typeof data.flags !== 'object' || Array.isArray(data.flags)) {
    throw new Error('AI response did not include flags');
  }

  const flags = {};

  Object.entries(AI_RESPONSE_FLAG_FIELDS).forEach(([aiField, nodeField]) => {
    if (typeof data.flags[aiField] !== 'boolean') {
      throw new Error(`AI response flag ${aiField} was not a boolean`);
    }
    flags[nodeField] = data.flags[aiField];
  });

  return {
    source: 'ai',
    risk: data.risk,
    score: data.score,
    flags,
    rawProba:
      data.raw_proba && typeof data.raw_proba === 'object' ? data.raw_proba : null,
  };
};

const buildFallbackAssessment = (input = {}, reason) => {
  const data = input && typeof input === 'object' ? input : {};
  const heartRate = Number(data.heartRate);
  const spo2 = Number(data.spo2);
  const bpSystolic = Number(data.bpSystolic);

  let risk = 'low';
  if (heartRate > 115 || spo2 < 90) risk = 'high';
  else if (heartRate > 100 || spo2 < 94) risk = 'medium';

  return {
    source: 'fallback',
    risk,
    score: null,
    flags: {
      hrAlert: heartRate > 100,
      spo2Alert: spo2 < 94,
      bpAlert: bpSystolic > 140,
    },
    rawProba: null,
    fallbackReason:
      reason instanceof Error ? reason.message : String(reason || 'AI service unavailable'),
  };
};

const RISK_SCORE_FALLBACK = Object.freeze({ low: 20, medium: 55, high: 85 });

const riskScoreFromAssessment = (assessment = {}) => {
  if (assessment.source === 'ai' && typeof assessment.score === 'number') {
    return Math.max(0, Math.min(100, Math.round(assessment.score * 100)));
  }
  return RISK_SCORE_FALLBACK[assessment.risk] ?? 0;
};

const buildAssessmentExplanation = (input = {}, assessment = {}) => {
  const data = input && typeof input === 'object' ? input : {};
  const flags = assessment.flags || {};
  const contributors = [];

  if (flags.hrAlert) contributors.push(`heart rate ${data.heartRate} bpm`);
  if (flags.spo2Alert) contributors.push(`SpO2 ${data.spo2}%`);
  if (flags.bpAlert) contributors.push(`systolic BP ${data.bpSystolic} mmHg`);

  const sourceLabel =
    assessment.source === 'ai'
      ? `Experimental ML classifier (${Math.round((assessment.score || 0) * 100)}% confidence)`
      : 'Transparent rule-based fallback';

  const reason =
    assessment.source === 'ai'
      ? 'This is a current-state estimate, not a validated 24-48 hour deterioration forecast.'
      : `Rules triggered from configured thresholds. Fallback reason: ${
          assessment.fallbackReason || 'AI service unavailable'
        }`;

  return `${sourceLabel} classified this reading as ${assessment.risk} risk. ${
    contributors.length
      ? `Contributing observations: ${contributors.join(', ')}.`
      : 'No configured observation threshold was crossed.'
  } ${reason}`;
};

const createAiService = ({
  httpClient = axios,
  baseUrl = DEFAULT_AI_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) => {
  const predictRisk = async (data) => {
    try {
      const response = await httpClient.post(`${baseUrl}/predict`, toAiRequest(data), {
        timeout: timeoutMs,
      });
      return normalizeAiResponse(response?.data);
    } catch (error) {
      return buildFallbackAssessment(data, describeAiError(error));
    }
  };

  const checkHealth = async () => {
    const startedAt = Date.now();

    try {
      const response = await httpClient.get(`${baseUrl}/health`, {
        timeout: Math.min(timeoutMs, HEALTH_TIMEOUT_MS),
      });
      const healthy = response?.status === 200 && response?.data?.status === 'ok';

      return {
        status: healthy ? 'up' : 'down',
        url: baseUrl,
        latencyMs: Date.now() - startedAt,
        ...(healthy
          ? {}
          : { error: 'AI service returned an unexpected health response' }),
      };
    } catch (error) {
      return {
        status: 'down',
        url: baseUrl,
        latencyMs: Date.now() - startedAt,
        error: describeAiError(error),
      };
    }
  };

  return { predictRisk, checkHealth };
};

// ── getConditionProtocol ─────────────────────────────────────────────────────
// Returns handling instructions for a given condition (replicated from AI model)
const getConditionProtocol = (condition) => {
  const protocols = {
    hydrocephalus: {
      instructions: 'Avoid neck movement. Keep head elevated at 30°. Monitor for nausea or altered consciousness.',
      restrictions: ['no_sudden_movement', 'head_elevated'],
    },
    cardiac: {
      instructions: 'Continuous ECG monitoring required. Do not exceed 0.5 m/s speed. Defibrillator must be accessible.',
      restrictions: ['ecg_required', 'slow_speed', 'defibrillator_nearby'],
    },
    icu: {
      instructions: 'Minimum 2 trained staff. All life-support equipment must remain connected. Alert receiving team 5 min before.',
      restrictions: ['two_staff_minimum', 'life_support_connected'],
    },
    respiratory: {
      instructions: 'Maintain oxygen supply. Avoid supine position for more than 2 minutes. Keep suction device ready.',
      restrictions: ['oxygen_required', 'position_monitored'],
    },
    general: {
      instructions: 'Standard transfer protocol applies.',
      restrictions: [],
    },
  };
  return protocols[condition] || protocols.general;
};

// ── suggestRoute ─────────────────────────────────────────────────────────────
// Asks Python AI for optimal route (elevator, corridor) avoiding crowd zones
const suggestRoute = async ({ fromWard, toWard }) => {
  try {
    const response = await axios.post(
      `${DEFAULT_AI_URL}/route`,
      { from_ward: fromWard, to_ward: toWard },
      { timeout: DEFAULT_TIMEOUT_MS }
    );
    const data = response?.data || {};
    return {
      ...data,
      estimatedMinutes: data.estimated_minutes ?? data.estimatedMinutes ?? null,
    };
  } catch {
    return {
      route: `${fromWard} → Main Corridor → ${toWard}`,
      estimatedMinutes: 15,
      source: 'fallback',
    };
  }
};

const defaultService = createAiService();

module.exports = {
  predictRisk: defaultService.predictRisk,
  checkHealth: defaultService.checkHealth,
  createAiService,
  buildFallbackAssessment,
  buildAssessmentExplanation,
  riskScoreFromAssessment,
  getConditionProtocol,
  suggestRoute,
};
