# Care-Verse: Ward Zero

### Intelligent home-healthcare monitoring and response prototype

> **Status:** hackathon prototype using synthetic data only. This is **not** a
> clinically validated system. Current-state risk assessment and experimental ML
> predictions are decision-support signals, not evidence that deterioration will
> occur 24–48 hours in advance. See [`CONTEXT.md`](CONTEXT.md) for the verified
> scope, commands, and known gaps.

Care-Verse: Ward Zero demonstrates a complete monitoring loop:

**Sense → Understand → Predict → Alert → Respond**

- Simulated bed/vitals sensors and named deterioration scenarios
- Reliable vitals ingestion with duplicate and late-reading handling
- Current-state risk assessment plus experimental ML prediction services
- Explainable alerts with acknowledgment, dismissal, escalation, and audit
- Stale, offline, and no-data safety states that never claim stability
- Responsive dashboard served by the backend over REST and Socket.IO

---

## Architecture

```text
                    ┌──────────────────────────────┐
                    │  Browser dashboard (vanilla) │
                    │  REST + Socket.IO + JWT auth │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  Node.js + Express + Socket.IO│
                    │  auth, patients, alerts,      │
                    │  transfers, audit, monitoring │
                    └───────┬──────────────┬────────┘
                            │              │
                 ┌──────────▼──────┐  ┌────▼─────────────────────┐
                 │ MongoDB (Mongoose)│ │ Python prediction services│
                 │ required          │ │ · ai-service :8000        │
                 └──────────────────┘ │ · medbed-ml   :8001        │
                                      └──────────────────────────┘
```

Services:

| Component | Port | Purpose |
|---|---:|---|
| Node backend + frontend | `5001` locally (`5000` default) | API, dashboard, Socket.IO, alert lifecycle, monitor |
| AI service (`medbed-fullstack/ai-service`) | `8000` | Current-state risk classification from one reading, with a tagged rule fallback |
| ML service (`medbed-ml`) | `8001` | Transfer, vitals time-series, and bed-safety predictions |
| MongoDB | `27017` local or Atlas | Required persistence; there is no in-memory fallback |

On macOS, AirPlay Receiver commonly occupies port `5000`. The verified local
setup uses `PORT=5001`.

---

## Quick start

Requirements:

- Node.js 18+ (verified on Node 25.9)
- Python 3.11 (verified; do not use 3.13 with the current AI pins)
- MongoDB local or Atlas (Atlas verified)
- Google Chrome if you want to run the committed browser suite

### 1. AI service (optional, but recommended)

```bash
cd medbed-fullstack/ai-service
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python train.py
uvicorn api:app --host 127.0.0.1 --port 8000
```

Without this service the backend still works and labels assessments as
`fallback` (rule-based).

### 2. ML service (optional for the app, required for the full test suite)

```bash
cd medbed-ml
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python train_all.py
uvicorn api.ml_api:app --host 127.0.0.1 --port 8001
```

The ML service trains and serves three experimental models:

- **Transfer** — risk level, staff count, estimated duration
- **Vitals** — time-series alert class and deterioration probability
- **Safety** — fall risk, bed imbalance, safety alert

The synthetic datasets and trained model artefacts used by this prototype are
committed under `medbed-ml/data/` and `medbed-ml/models/`. Retraining overwrites
them locally.

### 3. Backend

```bash
cd medbed-fullstack/backend
npm install
cp .env.example .env
# Edit .env:
#   MONGO_URI, JWT_SECRET, PORT=5001
#   AI_SERVICE_URL=http://127.0.0.1:8000
#   ML_SERVICE_URL=http://127.0.0.1:8001
npm run seed
npm start
```

Never commit `.env` or real credentials.

### 4. Open the dashboard

```text
http://127.0.0.1:5001/login.html
```

Serve the pages through the backend so `/api` and Socket.IO stay same-origin.
Do not open the HTML files with `file://`.

Synthetic demo accounts created by `npm run seed`:

| Role | Email | Password |
|---|---|---|
| Admin | `admin@careverse.com` | `WardZero!2026` |
| Doctor | `doctor@careverse.com` | `WardZero!2026` |
| Nurse | `nurse@careverse.com` | `WardZero!2026` |

Override the password with `DEMO_PASSWORD`. Public signup is limited to
doctor/nurse; admin accounts come from the seed script.

---

## Testing

With MongoDB, AI (`:8000`), and ML (`:8001`) running:

```bash
cd medbed-fullstack/backend
npm test            # 39 backend unit, safety, and ML contract tests
npm run test:e2e    # 41 Playwright browser checks (system Chrome)
npm run test:all    # both suites
```

Current verified result: **80/80 checks passed** (39 backend + 41 browser).

`npm test` includes ML contract tests that call `ML_SERVICE_URL`; without the ML
service those tests fail rather than silently skipping. The browser suite logs
in with the seeded doctor/admin accounts, mutates synthetic demo data, and
cleans up the temporary patient it creates.

The browser suite covers login, session persistence, all six dashboard pages,
live vitals and assessment display, scenario simulation, alert
acknowledgment/dismissal, no-data safety behavior, mobile `390x844` layout, and
zero uncaught page errors.

---

## Main API surface

All application routes except health and public auth require a JWT bearer token.

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/signup`, `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, `PATCH /api/auth/update-password` |
| Patients | `GET/POST /api/patients`, `GET/PATCH/DELETE /api/patients/:id` |
| Vitals | `POST/GET /api/patients/:id/vitals`, `POST /api/patients/:id/simulate` |
| Transfers | `GET/POST /api/transfers`, `GET/PATCH /api/transfers/:id`, approve/assess/progress actions |
| Alerts | `GET /api/alerts`, `GET /api/alerts/summary`, `PATCH /api/alerts/:id/acknowledge`, `PATCH /api/alerts/:id/dismiss` |
| Audit | `GET /api/audit` (admin/doctor) |
| Hospitals | `GET/POST /api/hospitals`, `PATCH/DELETE /api/hospitals/:id` |
| ML | `GET /api/ml/health`, `POST /api/ml/predict/{transfer,vitals,safety,all}`, `POST /api/ml/patients/:id/assess-transfer` |
| Health | `GET /api/health` (liveness), `GET /api/health/ready` (Mongo required; AI/ML reported separately) |

Vitals ingestion behavior:

- Duplicate `readingId` returns HTTP 200 with `duplicate: true` and does not
  create a second assessment or duplicate alert.
- Out-of-order readings are stored with `isLate: true` and do not overwrite the
  current risk or become the latest reading.
- Server-derived assessment fields cannot be overridden by the request body.
- Invalid blood pressure (`systolic <= diastolic`) is rejected.

Role rules are enforced by the backend: public signup is doctor/nurse only,
patient/transfer approvals require admin/doctor, and patient deletion requires
admin.

---

## Real-time events

Socket.IO connections require a JWT in `socket.handshake.auth.token` or an
`Authorization: Bearer ...` header.

| Direction | Events |
|---|---|
| Server → client | `system:welcome`, `patient:subscribed`, `bed:sensor`, `vitals:update`, `alert:new`, `alert:acknowledged`, `alert:resolved`, `alert:escalated`, `transfer:*` |
| Client → server | `subscribe:patient`, `user:activity`, `vitals:push`, `safety:push`, `transfer:assess`, `transfer:progress` |
| ML predictions | `ml:vitals_prediction`, `ml:safety_prediction`, `ml:transfer_assessment` |

---

## Safety behavior

- Only `live`/`recent` readings are treated as current.
- Stale readings show `REASSESS`.
- Offline or missing readings show `UNKNOWN — NO DATA`/`NO DATA`; they never
  claim the patient is stable.
- Late or replayed readings do not create active alerts or resolve current
  alerts based on historical data.
- Unacknowledged alerts escalate to doctors (level 1) then admins (level 2) after
  the configured timeout. Escalation changes alert routing only; it never
  initiates a clinical transfer.
- Alert acknowledgment is idempotent and audited. Dismissal requires a reason.
- Duplicate active alerts are suppressed by a dedup key and can recur after
  resolution/dismissal.
- If the AI service is unavailable, the backend falls back to labeled rules
  (for example HR > 100/115, SpO2 < 94/90, systolic BP > 140). Rule fallbacks do
  not fabricate an ML probability.

A reusable `SensorReplayBuffer` module provides FIFO replay, bounded exponential
backoff, dead-lettering of permanent validation failures, and optional disk
persistence. It is covered by tests but is **not** wired into the live dashboard
ingestion path yet.

---

## Prediction scope and limitations

- The AI service (`:8000`) performs **current-state** risk classification from a
  single reading. It is an experimental model trained on synthetic, rule-labeled
  data.
- The ML service (`:8001`) provides experimental transfer, vitals time-series,
  and bed-safety predictions. Its training data is synthetic.
- No clinical accuracy, precision, recall, ROC AUC, or prospective
  deterioration-horizon claim is made. Any metric must come from a reproducible
  run with the command and data split documented.
- Do not use this repository with real patient data.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | Backend HTTP port |
| `NODE_ENV` | — | Enables development logging |
| `MONGO_URI` | — | **Required** MongoDB local/Atlas URI |
| `JWT_SECRET` | — | **Required** JWT signing secret |
| `JWT_EXPIRES_IN` | `7d` | Token lifetime |
| `CLIENT_ORIGINS` | local dev origins | Comma-separated CORS origins |
| `AI_SERVICE_URL` | `http://localhost:8000` | AI service base URL |
| `ML_SERVICE_URL` | `http://127.0.0.1:8001` | ML service base URL |
| `ML_TIMEOUT_MS` | `5000` | ML request timeout |
| `PATIENT_MONITOR_INTERVAL_MS` | `15000` | Stale/offline monitoring interval |
| `ALERT_ACK_TIMEOUT_SECONDS` | `300` | Escalation timeout |
| `VITALS_STALE_SECONDS` | `60` | Stale-data threshold |
| `SENSOR_OFFLINE_SECONDS` | `180` | Offline threshold |
| `DEMO_PASSWORD` | `WardZero!2026` | Synthetic seed-account password |

Use `CLIENT_ORIGINS` (plural), not `CLIENT_ORIGIN`.

---

## Repository structure

```text
care-verse-ward-zero/
├── CONTEXT.md                  # authoritative project state and decisions
├── README.md
├── bed/                        # richer standalone bed emitter (unused copy)
├── medbed-fullstack/
│   ├── backend/
│   │   ├── config/ controllers/ middleware/ models/ routes/
│   │   ├── services/           # ingestion, AI/ML clients, alerts, monitor, replay
│   │   ├── sockets/            # authenticated Socket.IO + bed emitter + ML bridge
│   │   ├── scripts/seedDemo.js
│   │   ├── test/               # node:test suites + committed browser E2E
│   │   └── server.js
│   ├── ai-service/             # current-state FastAPI risk classifier
│   └── frontend/               # login, signup, and six-page dashboard
└── medbed-ml/
    ├── api/ml_api.py           # transfer/vitals/safety FastAPI service
    ├── data/                   # synthetic dataset generator + committed CSVs
    ├── models/                 # training scripts + committed model artefacts
    ├── backend/                # Node HTTP client + Socket.IO ML bridge
    └── frontend/ml_socket_client.js
```

`.env`, `node_modules`, Python virtual environments, and the AI service's
locally generated `.pkl` files are ignored. The `medbed-ml` synthetic datasets
and trained artefacts are committed.

---

## Documentation

- [`CONTEXT.md`](CONTEXT.md) — current verified state, decisions, known gaps
- [`medbed-fullstack/README.md`](medbed-fullstack/README.md) — backend/frontend details
- [`medbed-ml/README.md`](medbed-ml/README.md) — ML service details and contracts

The illustrative target metrics in the ML README were not measured in this
repository and should not be treated as results.

---

## Deferred / future work

- Wire the replay buffer into a live sensor-client ingestion path
- Caregiver shift check-in/check-out and explicit assignment policy
- Persisted historical trend endpoints
- A timed demonstration script
- Real EMR integrations, clinical datasets, and clinical validation
- Containerized deployment and multi-site coordination

---

Developed by Tanmay Jain for the Operation Ward Zero hackathon.
