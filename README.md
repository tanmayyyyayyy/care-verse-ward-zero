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

Full narration: [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md).

## Documentation
- [`docs/TECHNICAL_DOCUMENTATION.md`](docs/TECHNICAL_DOCUMENTATION.md): problem, architecture, risk method, limitations, future work
- [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md): demo video script
- [`CONTEXT.md`](CONTEXT.md): engineering notes from the earlier build
- [`docs/LEGACY_README.md`](docs/LEGACY_README.md): original README (inherited marketing copy; do not quote unmeasured claims)

## Tests
```bash
cd medbed-fullstack/backend
npm test            # 62 tests; 5 integration tests skip automatically if the optional ML service is not running
npm run test:e2e    # Playwright browser suite (requires Chromium)
```

## Key code
| Area | File |
|---|---|
| Early-warning score | `backend/services/earlyWarning.js` |
| Caregiver-note context | `backend/services/noteContext.js` |
| 24 to 48 h forecast | `backend/services/deteriorationForecast.js` |
| Composite explained risk | `backend/services/careIntelligence.js` |
| Caregiver presence / response | `backend/services/caregiverService.js` |
| Home hub (outage + replay) | `backend/services/deviceGateway.js`, `sensorReplayBuffer.js` |
| New API | `backend/routes/careRoutes.js` → `/api/care/*` |
| New UI | `frontend/care.js`, `frontend/care.css` |

(all under `medbed-fullstack/`)

## Third-party components
Express, Mongoose, Socket.IO, jsonwebtoken, bcryptjs, helmet, FastAPI, scikit-learn, pandas, NumPy; optional TensorFlow in `medbed-ml`. The early-warning score follows the publicly documented NEWS2 scoring chart (Royal College of Physicians). All patient data is synthetic.
