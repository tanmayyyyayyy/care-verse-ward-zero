# CareVerse Ward Zero: Technical Documentation

**Operation Ward Zero hackathon submission.** Experimental prototype on synthetic data. It is not a medical device and makes no diagnostic claim.

---

## 1. Problem understanding

At home, a patient's safety often depends on family members or caregivers who have no continuous monitoring, no early-warning signal, and no clear path for escalation. Hospitals solve this with monitoring, scoring, alerts, and accountable staff. Ward Zero shows how a bedroom can behave like a small ward by closing the full loop:

> **Sense → Understand → Predict → Alert → Respond**

| Stage | What the platform does |
|---|---|
| Sense | Simulated bedroom sensors send heart rate, SpO₂, blood pressure, respiratory rate and temperature through a home hub. |
| Understand | Each reading is validated, scored with a transparent early-warning score and an ML classifier, and combined with caregiver notes and patient factors. |
| Predict | A 24 h and 48 h trend projection shows what may happen if current trends continue. |
| Alert | Risks are categorised, de-duplicated, and routed to the responsible clinician with an explanation. |
| Respond | Caregivers check in, acknowledge alerts (timed and audited), and unanswered alerts escalate. |

## 2. Challenges addressed

The brief lists six optional challenges. All six are implemented.

| Challenge | Implementation | Where |
|---|---|---|
| Patient monitoring | Five vitals ingested, validated, stored, charted live over Socket.IO | `vitalsIngestionService.js`, dashboard |
| Caregiver monitoring | Check-in / check-out, presence (active / idle / not responding), per-caregiver acknowledgment counts and median response time | `caregiverService.js`, **Caregivers and Home Hub** page |
| System reliability | Home-hub replay queue with ordered replay, de-duplication, bounded exponential backoff and dead-lettering; stale/offline sensor states; AI-service fallback | `deviceGateway.js`, `sensorReplayBuffer.js`, `vitalsQuality.js` |
| Contextual intelligence | Vitals + patient factors (age, surgery, condition) + caregiver notes combine into one explained risk | `careIntelligence.js`, `noteContext.js` |
| Predictive analytics | 24 h / 48 h trend projection re-scored with the early-warning score | `deteriorationForecast.js` |
| Alert and escalation | Severity levels, dedup keys, escalation ladder, no-caregiver-on-duty escalation | `alertService.js`, `patientMonitorService.js` |

## 3. Architecture

```
 Bedroom sensors (simulated)
        │  POST readings
        ▼
 ┌────────────────┐   link down: queue (FIFO, ids, durable option)
 │  Home hub      │   link up:   replay in order with original timestamps
 │ deviceGateway  │
 └──────┬─────────┘
        ▼
 ┌─────────────────────────── Node.js / Express backend ───────────────────────────┐
 │ Ingestion: validate → de-duplicate → late-arrival check → store (MongoDB)       │
 │   ├─ AI service (FastAPI, RandomForest) → risk class + explanation (rule fallback)│
 │   ├─ Early-warning score (NEWS2-style, per-vital points)                        │
 │   ├─ Care intelligence: + caregiver notes + patient factors → composite risk    │
 │   ├─ Forecast: trend per vital → 24 h / 48 h projected score → forecast alert   │
 │   └─ Alerts: dedup, severity, escalation, audit log                             │
 │ Monitor loop: stale / offline sensors, ack timeouts, no-caregiver coverage      │
 └───────────────┬───────────────────────────────┬─────────────────────────────────┘
                 │ REST + Socket.IO              │
                 ▼                               ▼
        Dashboard (HTML/JS)               Optional medbed-ml service
        Home Care Intelligence,           (BiLSTM+GB vitals, safety, transfer)
        Caregivers & Home Hub             wired via ML_SERVICE_URL
```

**Stack:** Node.js 20, Express, Mongoose/MongoDB, Socket.IO, JWT with role-based access (admin / doctor / nurse), FastAPI + scikit-learn, vanilla JS dashboard with SVG charts, `node:test`, Playwright Core for browser tests.

## 4. Data processing and risk assessment

### 4.1 Early-warning score (explainable by construction)
Modelled on the published NEWS2 aggregate scoring chart (SpO₂ Scale 1). Each of respiratory rate, SpO₂, systolic BP, pulse and temperature contributes 0 to 3 points. Total ≥ 7 is high, 5 to 6 is medium, and any single vital scoring 3 is at least medium. The dashboard shows every vital's points, so a caregiver can see exactly why.

### 4.2 Machine-learning risk
A scikit-learn RandomForest trained on **synthetic** data classifies each reading. If the AI service is down, a clearly tagged rule-based assessment is used instead, and the source (`ai` or `rule_based`) is always stored and shown.

### 4.3 Contextual intelligence
Caregiver notes are analysed by a transparent phrase matcher (not a black box):
- Flags: confusion/drowsiness, breathing difficulty, chest pain, fall, bleeding (urgent); dizziness, vomiting, worsening pain (elevated); poor intake, missed medication, swelling (watch).
- **Negation is handled** ("no chest pain", "denies dizziness" do not trigger).
- **Context can only raise risk, never lower it.** Reassuring notes are displayed but never suppress an alert.
- New confusion adds 3 early-warning points, as in NEWS2.
- Urgent wording raises an immediate alert for the responsible clinician.
- Patients aged 65+, post-surgery, or with cardiac / respiratory / ICU conditions use a more sensitive forecast threshold (4 instead of 5).

Composite risk = max(AI risk, early-warning band), then raised by note context. No data or stale data yields **Unknown**, never "Low".

### 4.4 24 to 48 hour forecast
1. Take the most recent readings (windows of 16 and 8 are both evaluated; the more severe valid projection is kept).
2. Fit a least-squares trend to each vital. A vital contributes a trend only if the fit passes an R² gate (≥ 0.5), so noise does not create false alarms.
3. Project each vital to +24 h and +48 h, clamped to physiological bounds and a plausible maximum change.
4. Re-score the projected vitals with the early-warning score; report projected score and band, hours until the urgent threshold, and the vitals driving the change.
5. If the projected score reaches the urgent threshold, raise a `deterioration_risk` alert: **warning** when confidence is moderate, **info** when low (to limit alert fatigue).

Honesty guards: confidence is capped at "moderate"; fewer than 5 readings or less than 1 h of span returns "insufficient data"; every forecast carries an "experimental, not a diagnosis" statement. For simulated sensors, which compress time, each reading represents `SIM_MINUTES_PER_READING` (default 60) minutes of virtual time, and the UI says so.

### 4.5 Alerting and escalation
Alert types include threshold breaches (HR, SpO₂, BP), AI risk, stale data, sensor offline, deterioration forecast, caregiver concern, and escalation. Alerts are de-duplicated per patient and type, acknowledged with measured latency, escalated when unanswered, and every action is written to the audit log. If alerts wait while **no caregiver is checked in**, one critical coverage escalation is raised for the care coordinator.

## 5. Reliability and resilience

- **Home hub queue:** readings produced while the link is down are queued in order, replayed on reconnect with original timestamps and reading IDs, de-duplicated by the platform, and flagged late rather than silently overwriting newer data. Permanently invalid items go to a dead-letter list. Optional durable storage (`GATEWAY_BUFFER_PATH`) survives process restarts.
- **Live demonstration:** the **Caregivers and Home Hub** page has a "Cut the link / Reconnect and replay" control plus a synthetic sensor stream, so judges can see the outage and replay.
- **Safe failure modes:** stale or missing data never reads as "stable". Forecast failures never block ingestion. AI-service failure falls back to rules (tagged). Caregiver presence updates never break clinical flows.
- **Health checks:** `/api/health/ready` reports MongoDB (required), AI service and ML service (optional) status.

## 6. Clinical safety and privacy

- Synthetic data only; do not enter real patient information.
- The UI states the experimental status and avoids diagnostic wording ("may worsen if trends continue", "suggested next step").
- Role-based access, hashed passwords, JWT, audit trail of acknowledgments, notes, check-ins, and gateway actions.
- Seeded demo credentials are synthetic; change them before any real use.

## 7. Testing

- `npm test` in `medbed-fullstack/backend`: 62 tests (57 run, 5 integration tests that need the optional ML service are skipped when it is not running). New tests cover the early-warning boundaries, note negation, forecast behaviour (flat, noisy, declining, clamped, insufficient data), composite-risk rules, and caregiver presence helpers.
- `npm run test:e2e`: Playwright browser suite (needs a Chromium install).
- The care, caregiver and gateway REST endpoints and the new UI logic were exercised against a live backend and MongoDB during development.

## 8. Assumptions and limitations

- All data is synthetic; the ML model learns from synthetic distributions and has **no clinical validation**.
- The early-warning score is an adaptation for a prototype. Supplemental-oxygen status is assumed "room air", and consciousness is inferred only from caregiver notes.
- The forecast is a linear trend projection over a short window. It cannot anticipate sudden events and is weakest over 48 h; it is a heads-up, not a prediction of outcome.
- Note analysis is keyword-based and English-only; it can miss unusual phrasing.
- Escalation targets are role-based (assigned clinician, team, administrator); a real deployment would integrate SMS / phone / push.
- The home hub queue is per backend process; the optional file-backed mode is a prototype of durability.

## 9. Future improvements

Real device integration (BLE / MQTT), per-patient baselines and personalised thresholds, validated models with clinical partners, multilingual note understanding, family-member app with push notifications, and a federated edge buffer on the home hub.

## 10. Setup

See the root `README.md` (Docker one-command start, or manual start). Demo accounts: `doctor@careverse.com`, `nurse@careverse.com`, `caregiver@careverse.com`, `admin@careverse.com`, password `WardZero!2026`.
