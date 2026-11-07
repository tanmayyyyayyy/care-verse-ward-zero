# CareVerse Ward Zero
### Build a hospital that fits inside a bedroom

An intelligent home-healthcare monitoring and response prototype for the **Operation Ward Zero** hackathon.

> **Sense → Understand → Predict → Alert → Respond**
>
> Simulated bedroom sensors → home hub → monitoring platform → explainable risk and 24 to 48 h outlook → alerts and escalation → timed caregiver response.

**Experimental prototype on synthetic data. It is not a medical device and makes no diagnostic or treatment claim.**

---

## What it does

| Hackathon challenge | What you can see |
|---|---|
| Patient monitoring | Live HR, SpO₂, BP, respiratory rate and temperature over Socket.IO |
| Caregiver monitoring | Check-in / check-out, active / idle / not-responding presence, acknowledgment counts and median response time |
| System reliability | Cut the home-hub link, keep sending readings, reconnect: queued readings replay in order, de-duplicated. Stale and offline sensors never read as "stable". AI service down: tagged rule fallback |
| Contextual intelligence | Vitals + patient factors + caregiver notes (with negation: "no chest pain" is not a symptom) combine into one explained risk |
| Predictive analytics | 24 h and 48 h trend projection, hours-to-urgent, named driving vitals, confidence, "experimental" label |
| Alert and escalation | Severity levels, dedup, escalation ladder, no-caregiver-on-duty escalation, full audit log |
| Explainability and safety | Every score point traced to a vital or a note; context can only raise risk; no data means **Unknown**, never "Low" |

## Run it

### Option A: one command (Docker)
```bash
docker compose up --build
# open http://localhost:5001/login.html
```

### Option B: manual
Requirements: Node.js 18+, Python 3.11, MongoDB (local or Atlas).

```bash
# 1. AI service (optional: without it the backend uses a tagged rule fallback)
cd medbed-fullstack/ai-service
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt && python train.py
uvicorn api:app --host 127.0.0.1 --port 8000 &

# 2. Backend + dashboard
cd ../backend
npm install
cp .env.example .env          # set MONGO_URI and a long random JWT_SECRET
npm run seed                  # synthetic accounts and patients
npm start                     # http://127.0.0.1:5001/login.html
```

**Synthetic demo logins** (password `WardZero!2026`): `doctor@careverse.com`, `nurse@careverse.com`, `caregiver@careverse.com`, `admin@careverse.com`.

The optional `medbed-ml` service (BiLSTM + gradient boosting vitals model, safety and transfer models) is wired through `ML_SERVICE_URL`; the system runs fully without it.

## Try the 3-minute story
1. Sign in as the doctor. The strip across the top shows the five stages live.
2. **Caregivers and Home Hub** → choose a patient, scenario *Slow decline*, **Start sensor stream**.
3. **Home Care Intelligence** → watch the risk, early-warning breakdown and the 24 / 48 h outlook develop *before* emergency thresholds are hit.
4. Add a caregiver note such as "seems confused and drowsy since lunch": the score rises and an urgent alert is raised.
5. Back on the Home Hub: **Cut the link**, send readings, **Reconnect and replay**.
6. Sign in as the caregiver in another window: **Check in**, acknowledge the alert, and see the response time recorded.

## Automated Scripted Demo (3-Minute Story Runner)

You can run the entire 6-phase Ward Zero narrative hands-free via the CLI or dashboard:
```bash
# Automated scripted demo story (fast mode, ~25s)
./scripts/run_demo_story.sh --fast

# Real-time pacing (~3 minutes)
./scripts/run_demo_story.sh --full

# Custom pacing (e.g. 3x speed)
./scripts/run_demo_story.sh --speed 3
```

The script exercises the full mission loop:
**Sense** (stable vitals) → **Understand** (slow decline + caregiver note with symptom extraction) → **Predict** (24–48h deterioration trend predicted) → **Alert** (deterioration alert raised) → **Escalation** (unacknowledged alert escalates to clinician) → **Respond** (doctor ACK + intervention note + vital recovery).

Or trigger it manually from the dashboard:
1. Sign in as the doctor (`doctor@careverse.com` / `WardZero!2026`).
2. Open the **Demo Story** widget on the dashboard and click **▶ Run Demo Story (Fast)**.
3. Observe live progress across all 6 phases with real-time Socket.IO step events.

## Failure Injection & System Reliability Testing

The dashboard includes a dedicated **Failure Injection Panel** (admin/doctor only, operates exclusively on synthetic sensors):
- **Pause Sensor**: halts incoming sensor stream without dropping connection.
- **Drop Network**: disconnects gateway; readings safely queue in the durable FIFO replay buffer.
- **Reconnect & Replay**: re-establishes link and drains queue in strict order with backoff retry and deduplication.
- **Simulate AI Down**: injects AI service outage; backend immediately activates rule-based fallback and displays the fallback badge.
- **Inject Delay**: adds a 5-second simulated transport latency.
- **Inject Duplicate / Out-of-Order**: tests deduplication and late-arrival handling (`isLate: true`).
- **Live System Health Panel**: real-time Mongo, AI, ML, Socket, and buffer depth / dead-letter telemetry via `/api/health/ready`.

## Documentation
- [`docs/MODEL_CARD.md`](docs/MODEL_CARD.md): 24–48h deterioration trend model specification, features, training setup, and evaluation metrics
- [`docs/TECHNICAL_DOCUMENTATION.md`](docs/TECHNICAL_DOCUMENTATION.md): problem, architecture, risk method, limitations, future work
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md): demo video script
- [`CONTEXT.md`](CONTEXT.md): engineering source of truth and architectural audit
- [`docs/LEGACY_README.md`](docs/LEGACY_README.md): original README (inherited marketing copy; do not quote unmeasured claims)

## Tests
```bash
cd medbed-fullstack/backend
npm test            # 84 passing unit/safety tests (5 integration tests skip if ML service on :8001 is offline)
npm run test:e2e    # 61/61 Playwright browser E2E checks across 9 phases (requires Chrome)
```

## Key code
| Area | File |
|---|---|
| Early-warning score | `backend/services/earlyWarning.js` |
| Caregiver-note context | `backend/services/noteContext.js`, `symptomRules.json` |
| 24 to 48 h trend forecast | `backend/services/trendPredictionService.js`, `ai-service/api.py` |
| Composite explained risk | `backend/services/careIntelligence.js` |
| Caregiver presence / response | `backend/services/caregiverService.js` |
| Home hub (outage + replay) | `backend/services/deviceGateway.js`, `sensorReplayBuffer.js` |
| Failure injection & demo | `backend/services/demoScenarioService.js`, `scripts/run_demo_story.sh` |
| New API | `backend/routes/careRoutes.js` → `/api/care/*` |
| New UI | `frontend/care.js`, `frontend/care.css` |

(all under `medbed-fullstack/`)

## Third-party components
Express, Mongoose, Socket.IO, jsonwebtoken, bcryptjs, helmet, FastAPI, scikit-learn, pandas, NumPy; optional TensorFlow in `medbed-ml`. The early-warning score follows the publicly documented NEWS2 scoring chart (Royal College of Physicians). All patient data is synthetic.
