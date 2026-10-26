const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAiService,
  buildFallbackAssessment,
} = require('../services/aiService');

const AI_URL = 'http://ai.test';

const vitalsInput = {
  heartRate: 118,
  spo2: 89,
  bpSystolic: 150,
  bpDiastolic: 92,
  age: 72,
  condition: 'cardiac',
  isPostSurgery: true,
};

const expectedAiRequest = {
  heart_rate: 118,
  spo2: 89,
  bp_systolic: 150,
  bp_diastolic: 92,
  age: 72,
  condition: 'cardiac',
  is_post_surgery: true,
};

const validAiResponse = {
  risk: 'high',
  score: 0.9764,
  flags: {
    hr_alert: true,
    spo2_alert: true,
    bp_alert: true,
  },
  raw_proba: {
    high: 0.9764,
    medium: 0.0236,
    low: 0,
  },
};

const makeClient = (overrides = {}) => ({
  post: async () => {
    throw new Error('Unexpected AI POST request');
  },
  get: async () => {
    throw new Error('Unexpected AI GET request');
  },
  ...overrides,
});

test('maps camelCase input to the AI snake_case contract and normalizes flags', async () => {
  let request;

  const service = createAiService({
    baseUrl: AI_URL,
    httpClient: makeClient({
      post: async (url, payload, options) => {
        request = { url, payload, options };
        return { status: 200, data: validAiResponse };
      },
    }),
  });

  const result = await service.predictRisk(vitalsInput);

  assert.equal(request.url, `${AI_URL}/predict`);
  assert.equal(request.options.timeout, 3000);
  assert.deepEqual(request.payload, expectedAiRequest);
  assert.equal(Object.hasOwn(request.payload, 'heartRate'), false);
  assert.equal(Object.hasOwn(request.payload, 'isPostSurgery'), false);
  assert.deepEqual(result, {
    source: 'ai',
    risk: 'high',
    score: 0.9764,
    flags: {
      hrAlert: true,
      spo2Alert: true,
      bpAlert: true,
    },
    rawProba: validAiResponse.raw_proba,
  });
});

test('falls back to rules when the AI service returns HTTP 422', async () => {
  const error = Object.assign(new Error('Request failed with status code 422'), {
    response: { status: 422 },
  });

  const service = createAiService({
    baseUrl: AI_URL,
    httpClient: makeClient({
      post: async () => {
        throw error;
      },
    }),
  });

  const result = await service.predictRisk(vitalsInput);

  assert.equal(result.source, 'fallback');
  assert.equal(result.risk, 'high');
  assert.equal(result.score, null);
  assert.deepEqual(result.flags, {
    hrAlert: true,
    spo2Alert: true,
    bpAlert: true,
  });
  assert.match(result.fallbackReason, /HTTP 422/);
});

test('falls back when the AI response is malformed', async () => {
  const service = createAiService({
    baseUrl: AI_URL,
    httpClient: makeClient({
      post: async () => ({
        status: 200,
        data: {
          risk: 'high',
          score: 0.9,
          flags: { hr_alert: true, spo2_alert: true },
        },
      }),
    }),
  });

  const result = await service.predictRisk(vitalsInput);

  assert.equal(result.source, 'fallback');
  assert.equal(result.risk, 'high');
  assert.equal(result.score, null);
  assert.match(result.fallbackReason, /bp_alert/);
});

test('falls back when the AI service is unavailable', async () => {
  const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), {
    code: 'ECONNREFUSED',
  });

  const service = createAiService({
    baseUrl: AI_URL,
    httpClient: makeClient({
      post: async () => {
        throw error;
      },
    }),
  });

  const result = await service.predictRisk(vitalsInput);

  assert.equal(result.source, 'fallback');
  assert.match(result.fallbackReason, /connection refused|unavailable/);
});

test('falls back when the AI service request times out', async () => {
  const error = Object.assign(new Error('timeout of 3000ms exceeded'), {
    code: 'ECONNABORTED',
  });

  const service = createAiService({
    baseUrl: AI_URL,
    httpClient: makeClient({
      post: async () => {
        throw error;
      },
    }),
  });

  const result = await service.predictRisk(vitalsInput);

  assert.equal(result.source, 'fallback');
  assert.match(result.fallbackReason, /timed out/);
});

test('fallback thresholds preserve the existing rule-based behavior', () => {
  const cases = [
    {
      input: { heartRate: 80, spo2: 98, bpSystolic: 120 },
      risk: 'low',
      flags: { hrAlert: false, spo2Alert: false, bpAlert: false },
    },
    {
      input: { heartRate: 101, spo2: 93, bpSystolic: 150 },
      risk: 'medium',
      flags: { hrAlert: true, spo2Alert: true, bpAlert: true },
    },
    {
      input: { heartRate: 116, spo2: 95, bpSystolic: 120 },
      risk: 'high',
      flags: { hrAlert: true, spo2Alert: false, bpAlert: false },
    },
  ];

  cases.forEach(({ input, risk, flags }) => {
    const result = buildFallbackAssessment(input, 'test fallback');

    assert.equal(result.source, 'fallback');
    assert.equal(result.risk, risk);
    assert.equal(result.score, null);
    assert.deepEqual(result.flags, flags);
    assert.equal(result.fallbackReason, 'test fallback');
  });
});

test('reports AI health separately from readiness', async () => {
  let request;

  const service = createAiService({
    baseUrl: AI_URL,
    httpClient: makeClient({
      get: async (url, options) => {
        request = { url, options };
        return { status: 200, data: { status: 'ok' } };
      },
    }),
  });

  const health = await service.checkHealth();

  assert.equal(request.url, `${AI_URL}/health`);
  assert.equal(request.options.timeout, 1500);
  assert.equal(health.status, 'up');
  assert.equal(health.url, AI_URL);
  assert.equal(typeof health.latencyMs, 'number');
});

test('reports AI health as down when the AI service is unreachable', async () => {
  const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), {
    code: 'ECONNREFUSED',
  });

  const service = createAiService({
    baseUrl: AI_URL,
    httpClient: makeClient({
      get: async () => {
        throw error;
      },
    }),
  });

  const health = await service.checkHealth();

  assert.equal(health.status, 'down');
  assert.match(health.error, /connection refused/);
});
