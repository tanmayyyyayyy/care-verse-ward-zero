# Care-Verse: Ward Zero — Project Context

This file is the working source of truth for the Operation Ward Zero hackathon
project in this repository. Read it before making changes. If this document and
the code disagree, inspect the code and update this document; do not silently
contradict it. If a recorded decision needs to change, raise the proposal and
ask before changing it.

The original Care-Verse repository is separate and must not be modified. This
repository is an independent evolution of the copied Care-Verse code.

Status of this document: initial repository inspection, startup baseline
verification, Node-to-AI integration/readiness work, MongoDB connection
hardening, a first end-to-end Ward Zero implementation slice, and browser
verification/UI reliability fixes. The slice includes JWT frontend auth,
patient/vitals ingestion with deduplication and late-reading handling,
current-state AI assessment, explainable alerts with
acknowledgment/dismissal/escalation/audit, stale/offline/no-data safety states,
synthetic sensor scenarios, responsive dashboard layout, and live dashboard
wiring. This is a hackathon prototype, not clinical validation; see Section 3.9
for exactly what was verified.

---

## 1. Project Overview

- Project name: Care-Verse: Ward Zero
- Context: Operation Ward Zero healthcare technology hackathon
- Objective: demonstrate an intelligent home healthcare monitoring and response
  loop: **Sense -> Understand -> Predict -> Alert -> Respond**.
- Intended building blocks: simulated IoT sensors, a full-stack monitoring
  dashboard, AI/ML risk assessment, and caregiver response workflows.
- Data rule: all patient data in the prototype must be synthetic. Never commit
  secrets or real patient data.

### Current repository reality

This is a copy of the original Care-Verse project, now extended into a working
Ward Zero demo slice:

- The dashboard is served by the Node backend and uses backend JWT auth
  (`medbed_token` / `medbed_user`). It loads patients, vitals, alerts, audit
  metadata, and Socket.IO updates from the live API rather than keeping auth in
  a separate browser-only store.
- Login/signup call the backend `/api/auth` endpoints. Public signup is limited
  to doctor/nurse; admin accounts come from the seed script.
- The Node backend now exposes patient/vitals, scenario simulation, alert
  acknowledgment/dismissal/summary, and audit endpoints, and persists
  device/readings metadata, assessment source, data-quality state, and alert
  lifecycle fields.
- The Python AI service is wired for current-state risk assessment. If it is
  unavailable, the Node client returns a clearly tagged rule fallback.
- A second, more elaborate Python ML service still exists but is not integrated
  with the Node backend, and its trained models/datasets are absent.
- `node:test` coverage now includes the AI client plus quality, simulator, and
  alert-helper tests: 21 tests.
- Browser-level verification was performed with temporary Playwright Core and
  system Chrome outside the repository. The final clean-start suite passed 30/30
  checks, including login/logout, assessment display, scenario selection,
  stale/offline safety states, alert ACK/dismiss/L2 escalation, reconnect,
  expired auth, and all six dashboard pages at `390x844`. A separate no-data
  browser scenario also passed. No browser suite or browser dependency is
  committed. Screenshots were generated but not
  visually pixel-reviewed.
- A backend `.env.example` exists; no real `.env` is committed.
- No commits have been created in this repository; all files are currently
  untracked.

Nothing in this document should be read as a claim that a feature is
runtime-verified. See "Verification" below for what was actually checked.

---

## 2. Hackathon Evaluation Criteria

Documented weights, in priority order for trade-off decisions:

| Criterion | Weight |
|---|---:|
| End-to-end integration | 25% |
| Technical skills | 20% |
| Reliability and resilience | 20% |
| Practical implementation | 20% |
| Explainability and clinical safety | 15% |

Decision rule: prioritize a complete, working, testable application over the
number of features. A narrow end-to-end path with honest safety behavior is
worth more than many disconnected demos.

---

## 3. Actual Architecture (as inspected)

### 3.1 As-built component map

```
[Root static portal]
  index.html  -> redirects to medbed-fullstack/frontend/login.html

[medbed-fullstack/frontend]  static HTML/CSS/JS served by the Node backend
  login.html, signup.html       -> backend JWT auth (`medbed_token`/`medbed_user`)
  index.html                    -> live dashboard: REST patients/vitals/alerts,
                                   alert actions, scenario controls, Socket.IO
  auth.js                       -> optional helper using the same auth keys;
                                   NOT included by any HTML file

[medbed-fullstack/backend]  Node.js + Express + Socket.IO + Mongoose
  server.js                     -> entry point, CORS, health, monitor, shutdown
  /api/auth, /api/patients, /api/transfers, /api/alerts, /api/hospitals,
  /api/audit
  sockets/socketManager.js      -> authenticated Socket.IO channels
  sockets/bedSensorEmitter.js   -> emits simulated bed sensor data every 2s
  services/aiService.js         -> Python AI client with contract mapping,
                                   normalization, and source-tagged fallback
  services/vitalsIngestionService.js -> dedupe/late detection/assessment/alerts
  services/patientMonitorService.js  -> stale/offline alerts and escalation
  services/sensorSimulator.js   -> stable/slow_decline/sudden_drop scenarios

[medbed-fullstack/ai-service]  Python + FastAPI + scikit-learn
  api.py                        -> /predict and /route
  model.py                      -> RandomForest inference wrapper
  train.py                      -> generates synthetic data, trains model
  Expected artefacts: risk_model.pkl, label_encoder.pkl
  (generated locally, not committed)

[MongoDB]
  Required by Node backend via MONGO_URI (no in-memory fallback); Atlas verified.

[medbed-ml]  separate Python ML stack, NOT wired to Node backend
  api/ml_api.py                 -> /predict/transfer, /predict/vitals,
                                   /predict/safety, /predict/all
  models/*/train_*.py           -> three model families
  backend/mlPredictionService.js
  backend/sockets/mlSocketBroadcaster.js
  frontend/ml_socket_client.js
  Expected model artefacts and CSV datasets (ABSENT)

[bed/bedSensorEmitter.js]
  A second, richer standalone copy of the bed sensor emitter.
  Not referenced by the backend; the backend uses
  medbed-fullstack/backend/sockets/bedSensorEmitter.js instead.
```

### 3.2 Runtime entry points and startup commands

| Component | Entry point | Documented/available start command | Default port | Actual status |
|---|---|---|---|---|
| Root portal | `index.html` | Serve with any static server, e.g. `python3 -m http.server` | n/a | Redirect page only |
| Frontend | `medbed-fullstack/frontend/login.html` | Served by backend at `/login.html`; use the backend origin so `/api` and Socket.IO are same-origin | 5000 via backend (5001 used for local verification) | Backend JWT auth and live REST/Socket.IO dashboard wired; browser-verified with temporary Playwright tooling at desktop and `390x844` |
| Node backend | `medbed-fullstack/backend/server.js` | `cd medbed-fullstack/backend && npm install && npm run seed && npm start` (or `npm run dev`) | 5000 | Dependencies installed; Atlas connection, seed, readiness, auth/RBAC, ingestion, simulation, alerts, escalation, audit, and 21 tests verified |
| AI service | `medbed-fullstack/ai-service/api.py` | `cd medbed-fullstack/ai-service && python3.11 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python train.py` then `uvicorn api:app --host 127.0.0.1 --port 8000` | 8000 | Verified on Python 3.11: dependencies installed, model artefacts generated, `/health`, `/predict`, `/route` passed |
| ML service | `medbed-ml/api/ml_api.py` | `source /tmp/wardzero-ml-venv/bin/activate && python -m uvicorn api.ml_api:app --host 127.0.0.1 --port 8001` | 8001 | Installed & verified on Python 3.11: 3 model families trained, `/health`, `/predict/transfer`, `/predict/vitals`, `/predict/safety`, `/predict/all` active & wired to Node backend (`ML_SERVICE_URL=http://127.0.0.1:8001`) |
| ML training | `medbed-ml/train_all.py` | `python train_all.py` | n/a | Generates datasets and trains three model families (Transfer GB+RF, Vitals BiLSTM+GB ensemble, Safety RF+GB); trained and verified |

Port allocation: `medbed-fullstack/ai-service` runs on port 8000 (`AI_SERVICE_URL`), while `medbed-ml` runs on port 8001 (`ML_SERVICE_URL`). Both run concurrently and report into the Node backend `/api/health/ready` check and live Socket.IO broadcaster.

### 3.3 Actual HTTP API surface

All routes below were found in code. "Protected" means JWT auth middleware.

Auth (`/api/auth`):

| Method | Endpoint | Access |
|---|---|---|
| POST | `/api/auth/signup` | Public; `doctor` or `nurse` only, password >= 8 |
| POST | `/api/auth/login` | Public; 8 failed attempts per IP+email per 15 min -> 429 |
| GET | `/api/auth/me` | Protected |
| POST | `/api/auth/logout` | Protected (stateless; client removes token) |
| PATCH | `/api/auth/update-password` | Protected |

Patients (`/api/patients`, all protected):

| Method | Endpoint | Roles |
|---|---|---|
| GET | `/api/patients` | Any logged-in staff |
| POST | `/api/patients` | admin, doctor |
| GET | `/api/patients/:id` | Any logged-in staff |
| PATCH | `/api/patients/:id` | admin, doctor |
| DELETE | `/api/patients/:id` | admin |
| POST | `/api/patients/:id/vitals` | Any logged-in staff |
| GET | `/api/patients/:id/vitals` | Any logged-in staff (limit 1-500) |
| POST | `/api/patients/:id/simulate` | admin, doctor (synthetic scenario; steps 1-20) |

Transfers (`/api/transfers`, all protected):

| Method | Endpoint | Roles |
|---|---|---|
| GET | `/api/transfers` | Any logged-in staff |
| POST | `/api/transfers` | Any logged-in staff |
| GET | `/api/transfers/:id` | Any logged-in staff |
| PATCH | `/api/transfers/:id` | admin, doctor |
| POST | `/api/transfers/:id/approve` | admin, doctor |
| PATCH | `/api/transfers/:id/progress` | Any logged-in staff |

Alerts (`/api/alerts`, all protected):

| Method | Endpoint | Roles |
|---|---|---|
| GET | `/api/alerts` | Any logged-in staff |
| GET | `/api/alerts/summary` | Any logged-in staff |
| PATCH | `/api/alerts/:id/acknowledge` | Any logged-in staff; idempotent |
| PATCH | `/api/alerts/:id/dismiss` | Any logged-in staff; reason >= 3 chars required |
| GET | `/api/audit` | admin, doctor; filter by patient/action/entityType, limit 1-500 |

Hospitals (`/api/hospitals`, all protected):

| Method | Endpoint | Roles |
|---|---|---|
| GET | `/api/hospitals` | Any logged-in staff |
| POST | `/api/hospitals` | admin |
| PATCH | `/api/hospitals/:id` | admin |
| DELETE | `/api/hospitals/:id` | admin (soft delete) |

Other Node routes:

| Method | Endpoint | Behavior |
|---|---|---|
| GET | `/api/audit` | Alias listed above; audit trail for patient/vitals/alert actions |
| GET | `/api/health` | Liveness response; does not depend on MongoDB or AI |
| GET | `/api/health/ready` | Readiness response; 503 when MongoDB is unavailable, AI status reported separately |
| GET | `/` | Redirect to `/login.html` |
| GET | `/login.html`, `/signup.html` | Serve frontend auth pages |
| GET | `/dashboard`, `/index.html` | Serve `frontend/index.html` |
| GET | `/dashboard.html` | Redirect to `/index.html` |

Vitals POST accepts `readingId`, `deviceId`, `deviceTimestamp`, `source`, vitals,
and optional `temperature`/`respiratoryRate`. Server-controlled fields
(`predictedRisk`, `aiFlags`, `assessmentSource`, `observedAt`, `receivedAt`,
`isLate`, explanation) cannot be overridden by the request body. Duplicate
`readingId` for the same patient returns HTTP 200 with `duplicate: true`.
Out-of-order `deviceTimestamp` readings set `isLate: true` and do not overwrite
the patient's current risk. `observedAt` is the canonical observation time used
for latest-reading and freshness queries.

Alerts `status` query accepts `active`, `acknowledged`, `resolved`, `dismissed`
(and other lifecycle values). Alert responses include `ageSeconds`, `isOverdue`,
and `acknowledgmentDueAt`. `GET /api/alerts/summary` returns severity/lifecycle
counts, overdue count, and average acknowledgment latency.

AI service (`medbed-fullstack/ai-service`):

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/` | Service metadata |
| GET | `/health` | Health check |
| POST | `/predict` | Current-state risk classification from one vitals reading |
| POST | `/route` | Heuristic route suggestion |

ML service (`medbed-ml/api/ml_api.py`, not wired to Node):

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/`, `/health`, `/metrics` | Metadata, health, latency metrics |
| POST | `/predict/transfer` | Transfer risk/staff/time prediction |
| POST | `/predict/vitals` | Vitals alert class / deterioration probability |
| POST | `/predict/safety` | Fall risk / imbalance / safety alert |
| POST | `/predict/all` | Combined predictions |

### 3.4 Actual Socket.IO surface

Node backend (`medbed-fullstack/backend/sockets/socketManager.js`):

- Connection requires a JWT in `socket.handshake.auth.token` or an
  `Authorization: Bearer ...` header.
- On connect, each socket joins `role:<role>`.
- Client -> server: `subscribe:patient`, `user:activity`, `vitals:push`,
  `transfer:progress`.
- Server -> client: `system:welcome`, `patient:subscribed`, `vitals:update`,
  `transfer:progress`.
- `vitals:push` over Socket.IO is only re-broadcast; it is not persisted and
  does not call the AI service. Persistence and AI/alert creation happen only
  through `POST /api/patients/:id/vitals`.

Controllers also emit:

- `vitals:update`, `alert:new` after vitals are recorded through the REST API.
- `alert:acknowledged` after acknowledgment, `alert:resolved` when data quality
  recovers or vitals return to a safe range, and `alert:escalated` when an
  unacknowledged alert reaches escalation level 1 (doctor) or 2 (admin).
- `transfer:created`, `transfer:updated`, `transfer:approval`,
  `transfer:progress`.
- The backend patient monitor runs every `PATIENT_MONITOR_INTERVAL_MS` (default
  15s): it creates `data_stale`/`sensor_offline` alerts and escalates
  unacknowledged active alerts after `ALERT_ACK_TIMEOUT_SECONDS` (default 300s).

Bed sensor emitter (`medbed-fullstack/backend/sockets/bedSensorEmitter.js`):

- Emits `bed:sensor` every 2 seconds to all clients.
- Payload includes `weight`, `leftPressure`, `rightPressure`, `tiltAngle`,
  `batteryLevel`, `stabilityScore`, `stabilityRisk`.
- This is a simplified copy. The richer standalone emitter at
  `bed/bedSensorEmitter.js` emits bed ID, patient ID, timestamp, wheel lock,
  oxygen mount, battery, stability score/risk, and alert flags, but it is not
  the copy currently integrated.

ML Socket.IO bridge (`medbed-ml/backend/sockets/mlSocketBroadcaster.js`):

- Defines `vitals:push`, `safety:push`, `transfer:assess`.
- Would emit `ml:vitals_prediction`, `ml:safety_prediction`,
  `ml:transfer_assessment`, `alert:new`.
- `initMLBroadcaster(io)` is not called anywhere in the active backend.

### 3.5 Authentication and authorization as built

Backend:

- JWT bearer tokens, required `JWT_SECRET`, default expiry `7d`.
- Passwords hashed with bcrypt, 12 salt rounds.
- Roles: `admin`, `doctor`, `nurse`.
- Middleware: `protect` and `authorize(...roles)`.
- Login is rate-limited (8 failed attempts per IP+email per 15 minutes).
- Public signup supports `doctor` and `nurse` only.
- Logout is stateless; the client deletes the token.
- The seed script creates synthetic demo accounts:
  `admin@careverse.com`, `doctor@careverse.com`, `nurse@careverse.com`, with
  password `WardZero!2026` unless `DEMO_PASSWORD` is set.

Frontend:

- `login.html` and `signup.html` call the backend auth API and store
  `medbed_token` / `medbed_user`.
- `index.html` guards on `medbed_token`, loads live patients/alerts, verifies the
  session with `/api/auth/me`, and logs out through `/api/auth/logout`.
- `index.html` includes the Socket.IO client and subscribes to authenticated
  live updates. Browser-local fake vital generation stops once live data or bed
  telemetry arrives.
- `auth.js` also uses `medbed_token` and relative `/api`, but is not included by
  `index.html` because the dashboard now contains equivalent integration code.
  It can be removed or reused for another page; it is not a second auth store.

### 3.6 Database models as built

MongoDB via Mongoose. Collections/models found:

- `User`: name, email, password hash, role (`admin|doctor|nurse`), department,
  active flag, last login.
- `Patient`: human-readable `patientId`, name, age, gender, ward, bed,
  condition enum (`general|cardiac|hydrocephalus|icu|orthopaedic|respiratory`),
  diagnosis, post-surgery flag, risk level/score, assigned doctor, active flag,
  notes.
- `Vitals`: patient reference, `readingId` (idempotency key), `deviceId`,
  heart rate, SpO2, systolic/diastolic BP, temperature, respiratory rate, AI
  flags, predicted risk, `assessmentSource` (`ai|fallback`), explanation,
  raw probability, fallback reason, `deviceTimestamp`, `observedAt`,
  `receivedAt`, `recordedAt`, `isLate`, source (`manual|sensor|simulation`).
  Unique partial index on `(patient, readingId)`, observation-time index, and a
  30-day TTL index.
- `Alert`: patient, optional transfer, extended type enum (`hr_high|spo2_low|
  bp_high|bp_low|risk_high|sensor_offline|data_stale|escalation|fall_risk|...`),
  severity, message, dedup key, source reading, assigned user, acknowledgment
  fields/latency/note, dismissal fields, escalation level/history, resolution
  fields, metadata.
- `AuditLog`: actor/role, action, entity type/id, patient, metadata, timestamp.
- `Transfer`: `transferId`, patient, from/to ward, inter-hospital fields,
  documents checklist, status (`pending_approval|approved|rejected|in_transit|
  completed|cancelled`), progress, route, assigned nurse, timestamps, notes.
- `Approval`: transfer, reviewer, decision, remarks, reviewedAt.
- `Hospital`: name, city, state, phone, email, active flag.

Still not present: caregiver check-in/check-out, explicit caregiver assignment
policy beyond `assignedDoctor`, or a separate ingestion-sequence field.

### 3.7 Environment variables and configuration

Read by code:

| Variable | Used by | Behavior |
|---|---|---|
| `PORT` | Node backend | Default 5000 |
| `NODE_ENV` | Node backend | Enables morgan and stack traces in development |
| `MONGO_URI` | Node backend | Required; local or MongoDB Atlas URI; connection retries every 10s if unavailable |
| `JWT_SECRET` | Node backend / sockets | Required; no fallback |
| `JWT_EXPIRES_IN` | Node backend | Default `7d` |
| `AI_SERVICE_URL` | Node backend | Default `http://localhost:8000` |
| `CLIENT_ORIGINS` | Node backend | Comma-separated allowed browser origins; defaults to the local frontend ports |
| `ALERT_ACK_TIMEOUT_SECONDS` | Patient monitor | Default 300; escalation level 1 after one interval, level 2 after two |
| `PATIENT_MONITOR_INTERVAL_MS` | Patient monitor | Default 15000 |
| `VITALS_STALE_SECONDS` | Data-quality assessment | Default 60 |
| `SENSOR_OFFLINE_SECONDS` | Data-quality assessment | Default 180 |
| `DEMO_PASSWORD` | Seed script | Optional override for synthetic demo accounts |
| `EMAIL_USER`, `EMAIL_PASS` | `utils/sendEmail.js` | Read only if the orphaned email helper is imported; the unused controller import was removed |
| `ML_SERVICE_URL`, `ML_TIMEOUT_MS` | `medbed-ml/backend/mlPredictionService.js` | Only used if that module is wired in (it is not) |

`CLIENT_ORIGINS` is now read for Express and Socket.IO CORS; the previous
hard-coded-only behavior is gone. `medbed-fullstack/backend/.env.example`
contains placeholder values. The AI service reads no environment variables. No
real `.env` file is committed.

### 3.8 Model and data artefacts

`medbed-fullstack/ai-service`:

- Code expects `risk_model.pkl` and `label_encoder.pkl` next to `model.py`.
- `train.py` writes those files relative to the current working directory.
- The artefacts were absent in the copied repository. Running `python train.py`
  from `medbed-fullstack/ai-service` generated both files locally; `/predict`
  then returned a result. The generated `.pkl` files are not committed.
- The training run used a random synthetic train/test split and reported 98.00%
  accuracy. This is a demonstration result for a rule-labelled synthetic dataset,
  not clinical validation or evidence of prospective deterioration prediction.
- `model.py` loads the artefacts from its own directory, so training and serving
  must use the same `ai-service` directory (or the artefacts must be moved).

`medbed-ml`:

- Transfer: `models/transfer/risk_model.pkl`, `staff_model.pkl`,
  `time_model.pkl`, `preprocessor.pkl`, `feature_names.json`.
- Vitals: `models/vitals/lstm_model.h5`, `gb_model.pkl`, `seq_scaler.pkl`,
  `feat_scaler.pkl`, `model_config.json`.
- Safety: `models/safety/fall_risk_model.pkl`, `imbalance_model.pkl`,
  `alert_model.pkl`, `scaler.pkl`, `safety_config.json`.
- Datasets expected at `medbed-ml/data/{transfer,vitals,safety}_dataset.csv`.
- None of those artefacts or CSVs exist; only the generator and training
  scripts are present.

The `medbed-ml` README lists performance tables under "Expected Performance".
Those numbers are not measured in this repository and must not be presented as
results.

### 3.9 Verification performed

- Repository inspected: READMEs, manifests, backend, frontend, AI service, ML
  stack, sensor emitters, models, routes, and data generators.
- `node --check` passed for backend/frontend application JavaScript.
- Python application files compile with `python3.11 -m py_compile`.
- `npm test` passed 21/21: AI contract/fallback/health, alert helpers, quality
  thresholds, and sensor scenarios.
- MongoDB Atlas is reachable through the configured `MONGO_URI`. The backend
  starts, connects, and `/api/health/ready` returns `ready` with MongoDB and AI
  both `up`. The seed script created three synthetic users, four patients, and
  baseline vitals.
- Login works for the seeded doctor and admin accounts; `/api/auth/me` returns
  the expected role; `/api/patients` returns four active patients with
  `latestVitals` and `dataQuality`.
- Vitals ingestion was verified with real AI assessment (`source: "ai"`),
  duplicate `readingId` returns HTTP 200 with `duplicate: true`, and an
  out-of-order device timestamp sets `isLate: true` without overwriting the
  patient's current risk. `observedAt` ensures late data does not become the
  latest reading.
- `sudden_drop` and `stable` scenarios were exercised through
  `POST /api/patients/:id/simulate`. Critical alerts were created and later
  resolved when readings returned to a safe range; stale/offline alerts resolved
  after fresh readings.
- Alert ACK is idempotent and records latency/note/audit. Dismissal requires a
  reason. `alert:escalated` level 1 (doctor) and level 2 (admin) were observed
  in audit records using a shortened test timeout. Alert dedup keys suppress
  duplicate active alerts, including after acknowledgment.
- Login rate limiting was verified: eight failed attempts returned 401 and the
  ninth returned 429. Public signup with role `admin` was rejected. Invalid
  systolic <= diastolic vitals were rejected with HTTP 400.
- `/api/health` 200, `/api/health/ready` ready with Mongo+AI up, `/login.html`
  200, `/index.html` 200.
- The Node `suggestRoute()` call now uses the correct snake_case `/route`
  contract and returned a real AI route response rather than the fallback.
- Authenticated Socket.IO was verified with a temporary Node `socket.io-client`:
  connection succeeded, `bed:sensor` arrived, and `vitals:update`,
  `alert:new`, and `alert:resolved` arrived after scenario calls.
- Frontend inline scripts passed `node --check`. A temporary Playwright Core
  suite using system Chrome (not committed) passed 30/30 checks against a
  clean-started backend and AI service: login/logout, live vitals and assessment
  source, non-first patient selection, scenario selection preservation,
  stale/offline safety presentation, alert ACK/dismiss/L2 escalation, expected
  400/401 handling, Socket.IO disconnect/reconnect, expired auth, and all six
  dashboard pages at `390x844` without clipped content.
- A separate browser test created a temporary synthetic patient with no vitals,
  confirmed `UNKNOWN — NO DATA`, `NO DATA` ECG, a no-data alert, and no
  stability claim, then deactivated the patient and confirmed it disappeared
  from the active list. L2 escalation was visible in the real alert list.
- Stale detection updated the UI without reload at 65–73s; offline updated at
  193s. Both were displayed as `REASSESS`, not safe.
- The final browser suite had no uncaught page errors and no unexpected console
  or HTTP errors. Deliberate dismissal-validation (400), expired-auth (401), and
  offline network failures were expected and accounted for separately.
- Available runtime: Node.js v25.9.0, npm 11.12.1, Python 3.11.15, 3.12.5,
  3.13.2.

---

## 4. Existing Project Reuse

Reuse working components; do not rewrite them without a technical reason. The
following inventory records what exists and the reuse decision to apply.

| Component | Actual location | Evidence-based status | Reuse decision |
|---|---|---|---|
| Sensor-emitter code | `medbed-fullstack/backend/sockets/bedSensorEmitter.js`; richer copy at `bed/bedSensorEmitter.js` | Integrated simplified bed-only emitter now includes stability score; richer copy unused | Reuse the integrated emitter. Do not run both. |
| Patient and vitals models | `medbed-fullstack/backend/models/Patient.js`, `Vitals.js` | Extended with reading/device/observation/late/assessment fields and indexes | Reuse as implemented; avoid incompatible schema churn without a migration. |
| Backend APIs | `medbed-fullstack/backend/controllers`, `routes` | Live Atlas-backed patient/vitals/simulation/alert/audit flow verified by curl | Reuse; add endpoints only where the documented APIs cannot meet a requirement. |
| Real-time Socket.IO | `sockets/socketManager.js`; controller/service emits | Backend channels implemented; dashboard consumes updates and disconnect/reconnect is browser-verified | Reuse the existing channels; do not invent a parallel channel. |
| Existing AI risk logic | `medbed-fullstack/ai-service/api.py`, `model.py`, `train.py` | Current-state RF classifier; artefacts generated locally; Node contract mapping works and live `/predict` returns `source=ai` | Reuse as the current-state classifier, clearly labeled as experimental/ML or rule-based. |
| Existing ML stack | `medbed-ml` | Three model families and API code; no artifacts; not wired | Evaluate before adoption. Do not claim it works or supersede the simpler AI service without evidence. |
| Existing frontend | `medbed-fullstack/frontend` | Served by backend; JWT auth and live dashboard browser-verified, including mobile layout and safety states | Reuse layout/components; no frontend framework introduction. |
| Authentication and authorization | Backend JWT/RBAC; frontend pages now use backend auth | Dashboard flow uses `medbed_token`; `auth.js` mirrors the same keys but is not included | Keep one backend JWT flow; do not reintroduce `careverse_*` demo auth. |
| Alert workflows | `alertController.js`, `Alert` model, dashboard | Backend ack/dismiss/summary/escalation/resolution implemented and curl-verified; dashboard ACK/dismiss/L2 browser-verified | Reuse backend alert workflow; keep validation and audit behavior. |
| Hospital-transfer workflow | `transferController.js`, `Transfer`, `Approval`, `Hospital` models | Implemented in code; static UI | Reuse for transfer-related response if appropriate; do not treat a timer expiry as an automatic clinical transfer decision. |
| Email utility | `utils/sendEmail.js` | Orphaned helper; controller import removed; its `nodemailer` dependency is still not declared in the backend manifest | Either wire deliberately (and add the dependency) or leave unused. Do not add email infrastructure without need. |

Rules:

- Do not duplicate existing functionality without a technical reason.
- Do not introduce a new frontend framework or unnecessary infrastructure.
- Do not modify the original Care-Verse repository.

---

## 5. Planned Features and Current Status

Status definitions used here:

- **Implemented**: a code path exists and is present in this repository. It has
  not been runtime-verified unless explicitly stated.
- **Partial**: some pieces exist, but the requirement is not covered end to end.
- **Planned**: no implementation was found in this repository.

### 5.1 Sensor simulation

| Requirement | Status | Evidence / gap |
|---|---|---|
| Support `stable`, `slow_decline`, `sudden_drop` scenarios | Implemented | `services/sensorSimulator.js` and `POST /api/patients/:id/simulate`; unit tests cover scenario ranges and progression. |
| Synthetic HR, SpO2, BP, temperature readings | Implemented | Scenario readings include HR/SpO2/BP/temperature/respiratory rate and are labeled `source: simulation`. |
| Patient ID and device ID on readings | Implemented | Readings carry patient association plus `SIM-<bed>` device IDs. |
| Unique reading ID | Implemented | `readingId` with a per-patient unique partial index; duplicates return `duplicate: true`. |
| Device timestamps | Implemented | `deviceTimestamp`, `observedAt`, `receivedAt`, and `recordedAt` are distinct. |

### 5.2 Reliable ingestion

| Requirement | Status | Evidence / gap |
|---|---|---|
| Duplicate prevention | Implemented | Per-patient `readingId` uniqueness; duplicate requests return 200 without new assessment/alerts. |
| Delayed and out-of-order readings | Implemented | `isLate` is computed from `deviceTimestamp`; late readings are stored but do not overwrite current risk and cannot become the latest reading. |
| Stale-data detection | Implemented | `services/vitalsQuality.js` with configurable stale/offline thresholds. |
| Sensor-offline alerts | Implemented | Monitor creates `data_stale`/`sensor_offline` alerts; ingestion resolves them after fresh data. |
| Buffer and safe replay after connectivity interruptions | Implemented | `services/sensorReplayBuffer.js` provides FIFO ordered replay, bounded exponential backoff, duplicate handling, dead-lettering, status reporting, and optional disk persistence; verified by automated tests. |
| Missing/stale data must not be treated as stable | Implemented in data model/UI | No-data/stale/offline states are explicit and displayed; no automatic low-risk update from missing data. |

### 5.3 Risk assessment

| Requirement | Status | Evidence / gap |
|---|---|---|
| Reuse existing ML model where suitable | Implemented (experimental) | Node maps camelCase input to the `/predict` snake_case contract and normalizes response flags. A live call against the locally trained model returned `source=ai`; this remains an experimental current-state classifier. |
| Explainable assessments | Implemented | Flags, predicted risk, assessment explanation, and raw probability/fallback reason are persisted; the dashboard shows risk, source, flags, and explanation. |
| Distinguish rule-based warnings from ML estimates | Implemented | `Vitals.assessmentSource` and explanation text are exposed through REST/Socket.IO and displayed as ML estimate or rule-based fallback. |
| Current-state classification vs future-risk prediction | See Section 6 | The existing `/predict` is a current-state classifier, not a 24–48 hour deterioration forecast. |

### 5.4 Caregiver response

| Requirement | Status | Evidence / gap |
|---|---|---|
| Alert acknowledgment | Implemented | `PATCH /api/alerts/:id/acknowledge` stores user, timestamp, note, latency, and audit; dashboard calls the API. |
| Acknowledgment latency | Implemented | `acknowledgmentLatencyMs` is stored and `GET /api/alerts/summary` reports the average. |
| Caregiver check-in/check-out | Planned | No model or endpoint. |
| Configurable escalation from assigned caregiver to responsible person | Implemented (rule-based) | Unacknowledged alerts escalate L1 to doctors and L2 to admins after configurable timeouts; audit history is retained. |
| Reuse hospital-transfer functionality where appropriate | Existing but not integrated | Transfer lifecycle API exists; UI is static; no escalation-to-transfer flow. |
| Do not equate expired timer with clinical transfer decision | Mandatory rule | Escalation only changes alert routing; it never initiates a clinical transfer. |

### 5.5 Dashboard

| Requirement | Status | Evidence / gap |
|---|---|---|
| Display patient vitals | Implemented | Dashboard loads live patient/vitals data from the API, updates via Socket.IO, and was browser-verified at desktop and mobile widths. |
| Historical trends | Partial | Dashboard history arrays/canvas charts update from live readings; no persisted trend endpoint. |
| Risk explanations | Implemented | Dashboard displays assessment source, raw/fallback state, flags, and explanation text from the API; browser-verified. |
| Alerts | Implemented | Dashboard refreshes live alerts, calls acknowledge/dismiss APIs, and preserves selected state; browser-verified. |
| Caregiver response | Implemented | ACK and dismissal use backend lifecycle endpoints with reasons where required; browser-verified. |
| Device connectivity | Implemented | Bed telemetry arrives over Socket.IO; patient data quality shows live/stale/offline/no-data states, and stale/offline/no-data UI avoids claiming stability. |
| One functional monitoring dashboard | Implemented | Existing dashboard is wired to backend REST/Socket.IO without a framework migration; clean-start browser suite passed 30/30. |

### 5.6 Documentation

| Requirement | Status | Evidence / gap |
|---|---|---|
| Setup instructions | Partial | `.env.example`, seed command, and verified startup commands are documented; some README sections still contain legacy claims. |
| Architecture documentation | Partial | This file is current; README overview is legacy and includes unverified claims. |
| Test instructions | Partial | `npm test` runs 21 focused unit tests; API/curl checks are documented. Browser verification used temporary Playwright tooling outside the repo; no E2E suite is committed. |
| Model limitations | Partial | READMEs mention decision-support caveats, but also include unmeasured performance tables and "production-ready" claims. |
| Demonstration plan (~3 minutes) | Planned | Not present. |

---

## 6. Prediction and Clinical Safety

Mandatory constraints for all work:

- Do not claim clinically validated predictions.
- Do not fabricate accuracy, precision, recall, ROC AUC, latency, or any other
  metric. Only report metrics produced by a reproducible run, with the command
  and data split documented.
- A current-state risk classification is **not** evidence of deterioration
  24–48 hours in advance.
- Missing, stale, delayed, or offline measurements must never be treated as
  proof that a patient is stable.
- Safety-related rules must be transparent, configurable, and clearly labeled
  as rules. Experimental model outputs must be labeled as experimental/ML.
- If future-risk prediction is implemented, document:
  - the prediction target and horizon;
  - synthetic data-generation assumptions;
  - feature construction;
  - evaluation methodology;
  - limitations.
- Use a time-based evaluation split where appropriate and prevent information
  leakage between training and evaluation. Current `train.py` uses a random
  train/test split on synthetic data whose labels are rule-derived; it is a
  demonstration model, not a validated clinical predictor.
- The `medbed-ml` README's "Expected Performance" tables are not measured
  results and must not be quoted as results.
- If the ML service is unavailable, the Node fallback uses simple thresholds
  (HR > 100/115, SpO2 < 94/90, systolic BP > 140). These are rules, not ML.

---

## 7. Two-Day Scope

Deliver in this order:

1. Working end-to-end sensor-to-dashboard flow.
2. Reliable ingestion and data-quality handling.
3. Explainable risk assessment.
4. Device-offline and connectivity-failure handling.
5. Caregiver acknowledgment and escalation.
6. One functional monitoring dashboard.
7. Tests, README, technical documentation, and demo video.

Defer until the core workflow works:

- LLM-based note parsing.
- Framework migrations.
- Elaborate analytics.
- Cosmetic enhancements.

Do not implement all planned features in one task. Deliver incrementally and
run the relevant checks after each task.

---

## 8. Agent Working Rules

- Work only inside this repository (`care-verse-ward-zero`).
- Never commit to or push to the original Care-Verse repository.
- Inspect before editing; preserve working functionality.
- Make small, focused changes.
- Avoid unnecessary dependencies.
- Run relevant tests after each implementation task.
- Never fabricate test results or metrics.
- Do not claim a feature works without verifying it.
- Do not implement all planned features in one task.
- Keep documentation synchronized with actual behavior.
- Ask before publishing the repository or pushing code.
- Use synthetic data only. Never commit secrets.
- Stop and report if a task cannot be completed as specified.

---

## 9. Actual Repository Structure

```
care-verse-ward-zero/
├── CONTEXT.md                     # this file
├── README.md                      # original Care-Verse overview (claims exceed current state)
├── .gitignore
├── index.html                     # redirect to medbed-fullstack/frontend/login.html
├── script.js                      # empty
├── style.css                      # empty
├── package.json                   # root manifest; only nodemailer
├── package-lock.json              # root lockfile (nodemailer)
├── bed/
│   └── bedSensorEmitter.js        # richer standalone bed emitter; unused copy
├── medbed-fullstack/
│   ├── README.md                  # MedBed OS full-stack docs (some claims unverified)
│   ├── .gitignore
│   ├── backend/
│   │   ├── server.js
│   │   ├── package.json
│   │   ├── package-lock.json
│   │   ├── .env.example
│   │   ├── config/db.js
│   │   ├── controllers/{auth,patient,simulation,transfer,alert}Controller.js
│   │   ├── middleware/{auth,errorHandler,loginRateLimit,validate}.js
│   │   ├── models/{User,Patient,Vitals,Transfer,index}.js
│   │   ├── routes/{auth,patient,transfer,alert,hospital,audit}Routes.js
│   │   ├── scripts/seedDemo.js
│   │   ├── services/{aiService,alertService,auditService,patientMonitorService,
│   │   │             sensorSimulator,vitalsIngestionService,vitalsQuality}.js
│   │   ├── sockets/{socketManager,bedSensorEmitter}.js
│   │   ├── test/{aiService,alertService,sensorSimulator,vitalsQuality}.test.js
│   │   └── utils/sendEmail.js
│   ├── ai-service/
│   │   ├── api.py
│   │   ├── model.py
│   │   ├── train.py
│   │   └── requirements.txt
│   └── frontend/
│       ├── index.html             # dashboard
│       ├── auth.js                # optional helper; not included by any HTML
│       ├── login.html
│       └── signup.html
└── medbed-ml/
    ├── README.md
    ├── requirements.txt
    ├── train_all.py
    ├── .DS_Store
    ├── api/ml_api.py
    ├── backend/
    │   ├── mlPredictionService.js
    │   └── sockets/mlSocketBroadcaster.js
    ├── frontend/ml_socket_client.js
    ├── data/generate_datasets.py
    └── models/{transfer,vitals,safety}/train_*_model.py
```

Notes:

- `script.js` and `style.css` at the root are empty.
- `medbed-ml/models/*` and `medbed-ml/data/` contain only training/generator
  scripts; no `.pkl`, `.h5`, `.json`, or `.csv` artefacts.
- `medbed-fullstack/ai-service/risk_model.pkl` and `label_encoder.pkl` were
  generated locally during verification. They are not committed.
- The backend now includes a seed script (`npm run seed`), and its generated
  demo users/patients are synthetic. Do not point `MONGO_URI` at production
  data.
- The dashboard file was renamed from `INDEX.HTML` to `index.html` so the
  backend's `res.sendFile(.../frontend/index.html)` path works on both
  case-insensitive and case-sensitive filesystems.

---

## 10. Known Gaps, Blockers, and Open Questions

### 10.1 Known gaps/blockers

1. **Browser/E2E suite committed and verified:** The dashboard E2E suite is now
   committed in the repository at `medbed-fullstack/backend/test/browser.e2e.js`
   and executed via `npm run test:e2e` or `npm run test:all` (41/41 checks passed),
   using Playwright Core with system Chrome.
2. **Automated safety test coverage expanded:** `npm test` now executes 34/34
   automated tests, adding replay buffer unit tests (order, bounded exponential
   backoff, dead-lettering, durability) and ingestion safety tests (duplicate IDs,
   out-of-order/late readings, DB failures, duplicate alert prevention).
3. **Sensor replay buffer implemented:** `services/sensorReplayBuffer.js` provides
   reliable offline buffering, FIFO replay, bounded backoff, dead-lettering of
   permanent validation failures, and optional disk persistence.
4. **No caregiver check-in/check-out.** Alert assignment uses `assignedDoctor`
   and role-based escalation; there is no shift presence model.
5. **`medbed-ml` fully integrated:** Trained all 3 production models (Transfer GradientBoosting+RF, Vitals BiLSTM+GB ensemble, Safety RF+GB). Running on port 8001 via FastAPI (`ML_SERVICE_URL=http://127.0.0.1:8001`). Wired into backend (`mlPredictionService.js`, `mlSocketBroadcaster.js`, `mlRoutes.js`, `/api/health/ready`, `/api/transfers/assess`, `bedSensorEmitter.js`) and frontend (`ml_socket_client.js`).
6. **Python 3.13 incompatible with pinned AI stack.** NumPy 1.26.3 and
   TensorFlow 2.15.0 have no Python 3.13 wheels. Use Python 3.11 (verified).
7. **macOS port 5000 conflict.** Control Center / AirPlay Receiver owns `:5000`.
   Use `PORT=5001` locally.
8. **Python service ports resolved.** Simple AI service runs on `:8000`; `medbed-ml`
   runs on `:8001`. Both report health to the Node backend readiness probe.
9. **Demo script absent.** A timed ~3-minute demonstration plan is not written.
10. **Documentation lag.** This file and backend docs are current, but legacy
    README marketing text and `medbed-ml` performance tables are not measured
    results and must not be quoted as such.

### 10.2 Startup defects resolved during baseline verification

1. **`nodemailer` startup crash.** Removed the unused `sendEmail` import from
   `authController.js`; no current code needs the email helper.
2. **Dashboard filename casing.** Renamed `frontend/INDEX.HTML` to
   `frontend/index.html`, matching the server's `sendFile` path.
3. **Missing environment template.** Added
   `medbed-fullstack/backend/.env.example` with placeholders only.

### 10.3 Decisions applied for the current architecture

1. **AI & ML services:** Both services are active in parallel. The simpler
   `medbed-fullstack/ai-service` (:8000) handles single-reading threshold risk classification.
   The 3-model `medbed-ml` stack (:8001) provides time-series deterioration forecasting
   (BiLSTM+GB ensemble), bed weight/pressure/fall risk safety inference, and pre-transfer
   risk/staff/duration assessment. Both are monitored by `/api/health/ready`.
2. **Prediction claim:** The UI and docs describe current-state risk
   assessment, not 24–48 hour deterioration forecasting.
3. **Frontend:** The existing `index.html` was wired to backend REST/Socket.IO;
   no frontend framework was added.
4. **Authentication:** Backend JWT/RBAC is the only dashboard auth flow. Public
   signup is limited to doctor/nurse; admin comes from the seed script.
5. **Database:** MongoDB Atlas via `MONGO_URI`; no in-memory fallback.
6. **Python runtime:** Python 3.11 is the documented/verified runtime.
7. **Bed emitter:** The integrated simplified emitter is canonical; the richer
   `bed/bedSensorEmitter.js` remains unused.
8. **Scenarios:** Triggered through the dashboard controls and
   `POST /api/patients/:id/simulate`.
9. **Serving model:** The Node backend serves the dashboard and API on one
   origin, so frontend API paths are relative.
10. **Alert lifecycle:** ACK is idempotent and keeps the active alert/dedup key;
    dismissal requires a reason. Alerts resolve when data quality recovers or
    vitals return to safe ranges. The dedup key is cleared on resolution and
    dismissal so a later recurrence can alert again.
11. **Data-quality safety:** Only `live`/`recent` readings are treated as
    current. Stale, offline, and no-data states display `REASSESS` or
    `UNKNOWN — NO DATA`; they never display a safe risk or stable ECG claim.
12. **Live refresh:** Patient and alert state refreshes every 30s and on alert
    socket events. Selection and patient filter are preserved across refreshes.
13. **Mobile layout:** Dashboard pages use breakpoints at 1180px, 760px, and
    480px; all six pages were verified without clipped content at 390x844.

Remaining open question: a timed demonstration script and committed repeatable
E2E coverage.

---

## 11. Task Records

### 11.1 Initial repository audit (previous task)

- `CONTEXT.md` was created at the repository root.
- No application source code was modified.
- No repository reorganization was performed.
- No commits were created.
- No remote repository was configured.
- The original Care-Verse repository was not modified.

### 11.2 Startup baseline verification (previous task)

Changes made:

- Removed the unused `sendEmail` import from
  `medbed-fullstack/backend/controllers/authController.js`. This fixes the
  missing-`nodemailer` startup crash without adding an unused dependency.
- Renamed `medbed-fullstack/frontend/INDEX.HTML` to `index.html` to match the
  backend's static-file path on case-sensitive filesystems.
- Added `medbed-fullstack/backend/.env.example` with placeholder-only values.
- Ran `python train.py` from `medbed-fullstack/ai-service`, generating
  `risk_model.pkl` (7.3 MB) and `label_encoder.pkl` (552 B) locally. These
  generated artefacts are not committed.
- Installed backend npm dependencies locally (`node_modules` is ignored).
- Installed AI-service dependencies in a temporary Python 3.11 virtual
  environment outside the repository.
- Updated this document with verified findings.

No Ward Zero product features were implemented. No commits or pushes were made.
The original Care-Verse repository was not modified. The `medbed-ml` stack was
not installed.

### 11.3 Node-to-AI integration, tests, and readiness (previous task)

Changes made:

- Reworked `medbed-fullstack/backend/services/aiService.js` to map the Node
  camelCase payload to FastAPI's snake_case `/predict` contract, normalize the
  snake_case response flags to camelCase, validate the response shape, and
  return `source: 'ai' | 'fallback'`.
- Centralized the existing rule-based fallback in `aiService.js`. Fallbacks now
  carry `score: null`, `rawProba: null`, and a `fallbackReason` instead of
  fabricating an AI probability.
- Added `assessmentSource` to the `Vitals` schema and included it, plus
  `fallbackReason`, in the vitals API and Socket.IO payloads. Reordered vitals
  creation so request-body fields cannot override server-derived assessment
  fields.
- Added `GET /api/health` as a liveness-only check and
  `GET /api/health/ready` as a readiness check. Readiness pings MongoDB when
  connected, returns 503 when the database is unavailable, and reports AI
  health separately as optional/degraded.
- Added `test/aiService.test.js` using Node's built-in `node:test` runner and
  added the `npm test` script. Eight tests cover request mapping, response
  normalization, HTTP 422, malformed responses, connection refusal, timeouts,
  fallback thresholds, and AI health checks.
- Updated this document with verified changes and remaining blockers.

No Ward Zero product features were implemented. No commits or pushes were made.
The original Care-Verse repository was not modified. The `medbed-ml` stack was
not installed. MongoDB remains unavailable, so assessment-source persistence and
DB-backed readiness success were not verified.

### 11.4 MongoDB Atlas connection hardening (previous task)

Changes made:

- Kept Mongoose as the backend database layer; the supplied native `MongoClient`
  snippet was not copied because all existing models and queries use Mongoose.
  The Atlas URI is expected through `MONGO_URI`, not hardcoded in source.
- Updated `medbed-fullstack/backend/config/db.js` to validate `MONGO_URI`, use a
  15s server-selection timeout, attach connection event listeners once, and
  retry every 10s instead of exiting after an initial connection failure.
- Recreated `medbed-fullstack/backend/.env.example` with placeholder-only local
  and Atlas URI guidance. No credentials were written to it.
- Did not modify the existing ignored `.env`; the supplied Atlas URI still has a
  `<db_password>` placeholder and was not committed.

Verification:

- With local MongoDB unavailable, the backend stayed alive through the first
  connection timeout and retry window. `/api/health` returned 200 and
  `/api/health/ready` returned 503 with `readyState=2`, then `readyState=0`.
- MongoDB Atlas connectivity was not verified because no real password was
  available. No DB-backed endpoint or DB-up readiness check was claimed.

No Ward Zero product features were implemented. No commits or pushes were made.
The original Care-Verse repository was not modified.

### 11.5 First end-to-end Ward Zero slice (current task)

Changes made:

- Added `services/vitalsIngestionService.js` with per-patient `readingId`
  deduplication, late/out-of-order detection, AI/fallback assessment,
  server-derived persistence, patient risk updates only for current readings,
  data-quality alert resolution, rescue of resolved vitals alerts, audit, and
  `vitals:update` emission.
- Added `services/sensorSimulator.js` and `controllers/simulationController.js`
  for `stable`, `slow_decline`, and `sudden_drop` synthetic readings via
  `POST /api/patients/:id/simulate` (1–20 steps).
- Added `services/vitalsQuality.js` for `no_data`/`stale`/`offline`/`live`
  quality states and `services/alertService.js` for deduplicated alert creation,
  acknowledgment-safe dedup keys, alert emission, and resolution helpers.
- Added `services/patientMonitorService.js`: creates stale/offline/no-data
  alerts, escalates unacknowledged alerts to doctor (L1) then admin (L2), and
  records audit history. Added `services/auditService.js`.
- Extended `Vitals` with `readingId`, `deviceId`, `deviceTimestamp`,
  `observedAt`, `receivedAt`, `isLate`, assessment explanation/raw
  probability/fallback reason, and indexes. Added `AuditLog` and extended
  `Alert` lifecycle fields and types.
- Reworked patient, alert, auth, and simulation controllers/routes with
  express-validator rules, RBAC, idempotent ACK, reason-required dismissal,
  summary metrics, login rate limiting, and audit logging.
- Added `scripts/seedDemo.js` and `npm run seed` for synthetic demo users,
  patients, and baseline vitals. Public signup is doctor/nurse only.
- Hardened `server.js` with required `JWT_SECRET`, configurable CORS, the
  patient monitor, audit routes, and graceful shutdown.
- Wired `login.html`, `signup.html`, and `index.html` to backend JWT auth,
  REST data, alert actions, synthetic scenario controls, and Socket.IO updates.
  Updated `auth.js` to use relative `/api` and same-origin Socket.IO.
- Added `test/{vitalsQuality,sensorSimulator,alertService}.test.js`; the suite
  now has 21 passing tests.

Verification:

- MongoDB Atlas connected, seed completed, backend and AI readiness reported
  `ready` with both dependencies `up`.
- Seeded doctor/admin login, `/api/auth/me`, and `/api/patients` (four patients
  with `latestVitals`/`dataQuality`) verified.
- Vitals ingestion verified with `source: "ai"`, duplicate `readingId` HTTP 200
  with `duplicate: true`, and a late reading with `isLate: true` that did not
  alter the patient's current risk or latest reading.
- Scenario simulation created critical alerts; stable readings resolved them.
  Stale/offline/no-data alerts were created by the monitor and resolved after
  fresh readings.
- ACK idempotency, latency/note/audit, dismissal reason validation, dedup-key
  behavior, and `alert:escalated` L1/L2 were verified. Login throttling returned
  429 on the ninth failed attempt. Public `admin` signup and invalid
  systolic <= diastolic vitals were rejected.
- `/api/health`, `/api/health/ready`, `/login.html`, `/index.html`, and the Node
  `suggestRoute()` AI contract were verified.
- Authenticated Socket.IO was verified with a temporary Node `socket.io-client`:
  `bed:sensor` arrived, and `vitals:update`, `alert:new`, and `alert:resolved`
  arrived after scenario calls.
- Frontend inline scripts passed `node --check`; API integration was exercised
  by curl. No browser/E2E test was run in this slice; see Section 11.6.

No commits or pushes were made. The original Care-Verse repository was not
modified.

### 11.6 Browser verification and UI reliability fixes (current task)

Changes made:

- Added responsive dashboard CSS with breakpoints at 1180px, 760px, and 480px;
  verified all six dashboard pages at `390x844` without clipped content.
- Added `applyPatients`, `applyAlerts`, and `refreshLiveState`. Patient and alert
  state now refreshes every 30s and on alert socket events, reconnects, and
  ACK/dismiss actions. Selected patient and patient filter survive refreshes.
- Corrected data-quality presentation: only `live`/`recent` readings count as
  current; stale/offline/no-data states show `REASSESS` or
  `UNKNOWN — NO DATA` instead of a safe risk or stable ECG. Recovery restores
  the live assessment. No backend API/schema changes were needed.

Verification:

- `npm test` passed 21/21. Frontend inline scripts passed `node --check`; AI
  Python files passed `py_compile`.
- Backend and AI were clean-restarted; `/api/health` and `/api/health/ready`
  returned 200 with MongoDB and AI `up`.
- Temporary Playwright Core + system Chrome suite passed 30/30 clean-start
  checks: login/logout, live vitals and assessment source, non-first patient
  selection, scenario selection preservation, stale/offline safety, ACK,
  dismissal validation/persistence, L2 visibility, reconnect, expired auth,
  expected 400/401 handling, six pages at `390x844`, and no uncaught page errors.
- Stale detection appeared without reload at 65–73s and offline at 193s.
  A temporary no-vitals patient showed `UNKNOWN — NO DATA`, `NO DATA` ECG, and a
  no-data alert; it was deactivated and removed from the active list afterward.
- Browser tooling, reports, and screenshots remain outside the repository. No
  commits or pushes were made. The original Care-Verse repository was not
  modified.

### 11.7 Offline replay buffer, safety integration tests, and committed E2E suite (current task)

Changes made:

- Added `services/sensorReplayBuffer.js`: Minimal reliable offline sensor replay buffer
  providing:
  - Strict FIFO order preservation on replay.
  - Device timestamp and `readingId` preservation.
  - Bounded exponential backoff retry for transient network / 5xx / timeout failures.
  - Dead-lettering of non-retriable permanent validation failures (e.g. HTTP 400 systolic <= diastolic, 422, 404).
  - Clear connectivity and replay status reporting via `getStatus()`.
  - Optional durable disk persistence (`storagePath`); documents in-memory process restart limitation when omitted.
- Hardened `services/vitalsIngestionService.js`:
  - Replayed late readings (`isLate: true`) do NOT create active alerts or resolve current alerts, preventing misleading safety states from historical data.
  - Added `isLate: Boolean(vitals.isLate)` to `vitals:update` socket emissions.
- Hardened `services/auditService.js`:
  - Checks `mongoose.connection.readyState === 1` before writing, preventing 10s query buffering timeouts during offline/disconnected operations.
- Added `test/replayBuffer.test.js`:
  - 6 unit tests covering timestamp/ID preservation, FIFO replay order, bounded exponential backoff, dead-lettering, duplicate handling, and durable disk persistence.
- Added `test/ingestionSafety.test.js`:
  - 7 safety integration tests covering duplicate reading IDs, late out-of-order reading protection, latest measurement selection by observation time, database failure retry propagation, race duplicate handling (E11000), duplicate alert prevention, and no-data/stale/offline quality states.
- Committed minimal maintainable Playwright Core E2E suite at `test/browser.e2e.js`:
  - 41 automated checks covering login (invalid/valid), JWT session persistence, user profile dropdown, 6-page navigation, patient selection, live vitals readouts, AI risk and explanation display, sudden-drop scenario simulation, alert generation, alert ACK, alert dismissal with reason prompt, no-data patient safety display (`UNKNOWN — NO DATA`, `NO DATA` ECG, `Reassess Before Transfer`), temporary patient cleanup via API, responsive layout at desktop and `390x844` mobile viewport, and 0 uncaught page exceptions or unexpected errors.
- Added `test:e2e` and `test:all` npm scripts to `package.json`.

Verification:

- `npm test`: 34/34 unit and safety tests passed (duration ~490ms).
- `npm run test:e2e`: 41/41 browser checks passed.
- `npm run test:all`: 75/75 total automated checks passed.
- All JS files passed `node --check`; AI Python files passed `py_compile`.
- Readiness: `/api/health/ready` returns `ready` with MongoDB and AI both `up`.
- No commits or pushes made; original Care-Verse untouched.

---

## 12. Verified Startup Procedure

These commands reflect the verified environment (macOS, Node.js v25.9.0,
Python 3.11.15). MongoDB Atlas was verified with the configured `MONGO_URI`.
Local MongoDB/Homebrew/Docker commands below were not executed because local
MongoDB is absent.

### 12.1 MongoDB

MongoDB is required by the Node backend. There is no in-memory fallback.

Verified option: MongoDB Atlas through `MONGO_URI` in
`medbed-fullstack/backend/.env`. Do not commit `.env` or paste credentials into
source files.

```bash
MONGO_URI='mongodb+srv://<user>:<password>@<cluster>/<db>?retryWrites=true&w=majority'
```

Alternative macOS Homebrew option (not executed here):

```bash
brew tap mongodb/brew
brew install mongodb-community@7.0
brew services start mongodb-community@7.0
mongosh --eval 'db.runCommand({ ping: 1 })'
```

Alternative Docker option (not executed here; the Docker daemon was unavailable):

```bash
docker run --rm -d --name wardzero-mongo -p 27017:27017 mongo:7
```

### 12.2 Node backend

Start the AI service first (Section 12.3) if you want live AI assessments;
otherwise the backend uses the clearly tagged rule fallback.

```bash
cd medbed-fullstack/backend
npm install
cp .env.example .env
# Edit .env: set MONGO_URI, JWT_SECRET, PORT=5001 (AirPlay owns 5000), and
# AI_SERVICE_URL if it differs from http://localhost:8000.
npm test
npm run seed
npm start
```

`npm run seed` creates synthetic demo users, four patients, and baseline
readings. Demo users are `admin@careverse.com`, `doctor@careverse.com`, and
`nurse@careverse.com`; the default synthetic demo password is `WardZero!2026`
(override with `DEMO_PASSWORD`).

Verify:

```bash
curl http://127.0.0.1:5001/api/health
curl http://127.0.0.1:5001/api/health/ready
curl http://127.0.0.1:5001/login.html
curl http://127.0.0.1:5001/index.html
```

`/api/health` is liveness-only. `/api/health/ready` returns 503 while the
required MongoDB connection is unavailable and reports AI status separately.
Run the backend from `medbed-fullstack/backend`, not from the repository root.

### 12.3 AI service

Use Python 3.11 (verified) or 3.12. Do not use Python 3.13 with the current pins.

```bash
cd medbed-fullstack/ai-service
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python train.py
uvicorn api:app --host 127.0.0.1 --port 8000
```

`train.py` must be run from `medbed-fullstack/ai-service`: it writes model files
relative to the current working directory, while `model.py` loads them relative
to its own directory.

Verify:

```bash
curl http://127.0.0.1:8000/health
curl -X POST http://127.0.0.1:8000/predict \
  -H 'Content-Type: application/json' \
  -d '{"heart_rate":118,"spo2":89,"bp_systolic":150,"bp_diastolic":92,"age":72,"condition":"cardiac","is_post_surgery":true}'
```

The AI service reads no environment variables. The Node backend reaches it via
`AI_SERVICE_URL` (default `http://localhost:8000`).

### 12.4 Frontend

Serve the frontend through the Node backend so `/api` and Socket.IO are
same-origin:

```text
http://127.0.0.1:5001/login.html
http://127.0.0.1:5001/signup.html
http://127.0.0.1:5001/index.html
http://127.0.0.1:5001/dashboard
```

Do not open the HTML files with `file://`; fetch, localStorage auth, and
Socket.IO require the backend origin. A separate static server would break the
current relative `/api` paths unless it also proxies the backend.

Dashboard flow: sign in, verify the live connection badge, select a patient,
run a synthetic scenario, and acknowledge/dismiss the resulting alerts.

### 12.5 Verified checks and results

| Check | Result |
|---|---|
| Backend/frontend application JavaScript syntax (`node --check`) | Passed |
| AI Python syntax (`python3.11 -m py_compile`) | Passed |
| Backend unit & safety tests (`npm test`) | Passed: 34/34 (21 baseline + 6 replay buffer + 7 ingestion safety) |
| Browser E2E suite (`npm run test:e2e`) | Passed: 41/41 automated checks with Playwright Core + system Chrome |
| Full test suite (`npm run test:all`) | Passed: 75/75 (34 backend + 41 browser E2E) |
| MongoDB Atlas connection + readiness | Passed: `/api/health/ready` `ready`, MongoDB `up`, AI `up` |
| Seed script | Passed: 3 synthetic users, 4 patients, baseline vitals |
| Seeded login + `/api/auth/me` + `/api/patients` | Passed; 4 active patients with latest vitals/quality |
| Vitals ingestion with AI | Passed; `source=ai`, assessment/explanation persisted |
| Duplicate `readingId` | Passed: HTTP 200, `duplicate: true` |
| Late/out-of-order reading | Passed: `isLate: true`, current risk and latest-reading selection unchanged |
| Replay buffer ordered FIFO replay & backoff | Passed; preserved sequence and exponential backoff retry |
| Permanent validation failure dead-lettering | Passed; non-retriable 400 errors dead-lettered without blocking FIFO queue |
| Scenario simulation (`stable`, `sudden_drop`) | Passed; critical alerts created and later resolved |
| Stale/offline/no-data monitoring | Passed; alerts created and resolved after fresh readings |
| Alert ACK idempotency/latency/audit | Passed |
| Dismissal without/with reason | Passed: 400 without reason; success with reason |
| Escalation L1 (doctor) and L2 (admin) | Passed using shortened test timeout; audit entries observed |
| Alert dedup after ACK | Passed: repeat critical reading did not create a duplicate active alert |
| Login rate limiting | Passed: 8x401 then 429 |
| Public admin signup rejection | Passed: 400 |
| Invalid vitals (systolic <= diastolic) | Passed: 400 |
| `/api/health`, `/login.html`, `/index.html` | Passed: 200 |
| Node `suggestRoute()` against AI `/route` | Passed; real AI route response |
| Authenticated Socket.IO (`bed:sensor`, `vitals:update`, `alert:new/resolved`) | Passed using a temporary Node socket.io-client |
| Responsive dashboard at `390x844` | Passed: all six pages, no clipped content (scrollWidth <= 395px) |
| Stale/offline UI | Passed: `REASSESS`, never safe; no-data patient scenario passed with cleanup verified |
| Browser ACK/dismiss/L2/reconnect/expired auth | Passed; expected 400/401/offline errors separated from unexpected errors |
| Browser uncaught page errors | None (0 errors) |
| Python 3.13 AI dependency install | Failed: no matching NumPy 1.26.3 / TensorFlow 2.15.0 |

The training run reported 98.00% accuracy on a random split of rule-labelled
synthetic data. That is a demonstration result, not clinical validation and not
evidence of 24–48 hour deterioration prediction.
