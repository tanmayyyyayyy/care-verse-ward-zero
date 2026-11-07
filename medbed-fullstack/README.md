# MedBed OS — Full Stack System
### Smart Patient Transfer System with AI Risk Prediction & Real-Time Monitoring

---

## 📁 Project Structure

```
medbed-fullstack/
│
├── backend/                   # Node.js + Express API
│   ├── config/
│   │   └── db.js              # MongoDB connection
│   ├── controllers/
│   │   ├── authController.js  # signup, login, logout
│   │   ├── patientController.js
│   │   ├── transferController.js
│   │   └── alertController.js
│   ├── middleware/
│   │   ├── auth.js            # JWT protect + authorize(roles)
│   │   └── errorHandler.js    # Global error handler + AppError
│   ├── models/
│   │   ├── User.js            # Staff (Admin/Doctor/Nurse)
│   │   ├── Patient.js
│   │   ├── Vitals.js          # Time-series, TTL 30 days
│   │   ├── Transfer.js
│   │   └── index.js           # Approval, Alert, Hospital
│   ├── routes/
│   │   ├── authRoutes.js
│   │   ├── patientRoutes.js
│   │   ├── transferRoutes.js
│   │   ├── alertRoutes.js
│   │   └── hospitalRoutes.js
│   ├── services/
│   │   └── aiService.js       # Calls Python AI with fallback
│   ├── sockets/
│   │   └── socketManager.js   # Socket.IO with JWT auth
│   ├── .env.example
│   ├── package.json
│   └── server.js              # Entry point
│
├── ai-service/                # Python FastAPI microservice
│   ├── train.py               # Generate data + train model
│   ├── model.py               # Inference + route suggestion
│   ├── api.py                 # FastAPI endpoints
│   └── requirements.txt
│
└── frontend/                  # Alongside your existing HTML
    ├── login.html             # NEW: Login page
    ├── signup.html            # NEW: Signup page
    ├── auth.js                # NEW: Injects into existing dashboard
    └── index.html             # Your existing MedBed OS dashboard
```

---

## ⚡ Quick Start

### Prerequisites
- Node.js 18+ (verified on Node 25)
- Python 3.11 (verified) or 3.12; do not use 3.13 with the current pins
- MongoDB (local or Atlas; Atlas verified)

---

### Step 1 — Backend Setup

```bash
cd backend

# Install dependencies
npm install

# Copy and configure environment variables
cp .env.example .env
# Edit .env — set MONGO_URI and JWT_SECRET. On macOS use PORT=5001.

# Run tests and seed synthetic demo data
npm test            # 34/34 unit and safety tests
npm run test:e2e    # 41/41 Playwright browser checks
npm run test:all    # 75/75 full test suite
npm run seed

# Start the backend
npm run dev       # development (nodemon, auto-restart)
# or
npm start
```

Backend runs on the configured port (verified locally at
**http://localhost:5001**). Demo users are created by `npm run seed` with the
synthetic demo password `WardZero!2026` unless `DEMO_PASSWORD` is set.

---

### Step 2 — AI Service Setup

```bash
cd ai-service

# Create Python virtual environment
python3.11 -m venv venv
source venv/bin/activate          # Windows: venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt

# Train the risk prediction model (creates risk_model.pkl)
python train.py

# Start the AI API server
uvicorn api:app --host 127.0.0.1 --port 8000
```

AI service runs on: **http://localhost:8000**
API docs (auto): **http://localhost:8000/docs**

---

### Step 3 — Frontend

Serve the frontend through the Node backend so `/api` and Socket.IO are
same-origin:

```text
http://127.0.0.1:5001/login.html
http://127.0.0.1:5001/signup.html
http://127.0.0.1:5001/index.html
http://127.0.0.1:5001/dashboard
```

`login.html`, `signup.html`, and `index.html` already call the backend auth,
REST, and Socket.IO APIs. `auth.js` is an optional helper and is not included by
any page. Do not open the HTML files with `file://`.

Browser verification: 41/41 automated checks passed using the committed
Playwright Core suite (`npm run test:e2e`) with system Chrome. Coverage
includes login (valid/invalid credentials), JWT session persistence, profile
dropdown, 6-page navigation, patient selection, live vitals readouts, AI risk
and explanation display, sensor scenario simulation, alert generation, alert ACK,
alert dismissal with required reason prompt, no-data patient behavior
(`UNKNOWN — NO DATA`, `NO DATA` ECG, `Reassess Before Transfer`), temporary patient
cleanup via API, mobile layout at `390x844` across all six pages without clipped
content, and error integrity (0 uncaught page exceptions, 0 unexpected console errors).

---

## 🔐 Authentication Flow

```
User visits index.html
    ↓
auth.js checks localStorage for 'medbed_token'
    ↓ no token
Redirect to login.html
    ↓
User submits credentials → POST /api/auth/login
    ↓ success
JWT stored in localStorage
Redirect back to index.html
    ↓
auth.js verifies token on load (GET /api/auth/me)
auth.js injects user name + logout button into topbar
```

---

## 🗄️ Database Collections

| Collection  | Description                                       |
|-------------|---------------------------------------------------|
| `users`     | Hospital staff with hashed passwords + roles      |
| `patients`  | Patient records with AI risk scores               |
| `vitals`    | Time-series readings (auto-expire after 30 days)  |
| `transfers` | Transfer lifecycle (pending → approved → done)    |
| `approvals` | Management approval decisions with audit trail    |
| `alerts`    | System/AI alerts + ACK, dismissal, escalation     |
| `hospitals` | Hospital registry for inter-hospital transfers    |
| `auditlogs` | Audit trail for patient/vitals/alert actions      |

---

## 🌐 API Reference

### Auth

| Method | Endpoint                  | Access    | Description            |
|--------|---------------------------|-----------|------------------------|
| POST   | `/api/auth/signup`        | Public    | Create doctor/nurse account |
| POST   | `/api/auth/login`         | Public    | Login, returns JWT     |
| GET    | `/api/auth/me`            | Protected | Get current user       |
| POST   | `/api/auth/logout`        | Protected | Logout                 |
| PATCH  | `/api/auth/update-password` | Protected | Change password      |

### Patients

| Method | Endpoint                       | Access          |
|--------|--------------------------------|-----------------|
| GET    | `/api/patients`                | All             |
| POST   | `/api/patients`                | Admin, Doctor   |
| GET    | `/api/patients/:id`            | All             |
| PATCH  | `/api/patients/:id`            | Admin, Doctor   |
| DELETE | `/api/patients/:id`            | Admin           |
| POST   | `/api/patients/:id/vitals`     | All             |
| GET    | `/api/patients/:id/vitals`     | All             |
| POST   | `/api/patients/:id/simulate`   | Admin, Doctor   |

### Transfers

| Method | Endpoint                         | Access          |
|--------|----------------------------------|-----------------|
| GET    | `/api/transfers`                 | All             |
| POST   | `/api/transfers`                 | All             |
| GET    | `/api/transfers/:id`             | All             |
| POST   | `/api/transfers/:id/approve`     | Admin, Doctor   |
| PATCH  | `/api/transfers/:id/progress`    | All             |

### Alerts

| Method | Endpoint                          | Access  |
|--------|-----------------------------------|---------|
| GET    | `/api/alerts`                     | All     |
| GET    | `/api/alerts/summary`             | All     |
| PATCH  | `/api/alerts/:id/acknowledge`     | All     |
| PATCH  | `/api/alerts/:id/dismiss`         | All     |

### Audit and Health

| Method | Endpoint             | Access        |
|--------|----------------------|---------------|
| GET    | `/api/audit`         | Admin, Doctor |
| GET    | `/api/health`        | Public        |
| GET    | `/api/health/ready`  | Public        |

---

## 📡 Socket.IO Events

### Client → Server
| Event               | Payload                                          |
|---------------------|--------------------------------------------------|
| `subscribe:patient` | `patientId` string                               |
| `vitals:push`       | `{ patientId, heartRate, spo2, bpSystolic, … }` |
| `transfer:progress` | `{ transferId, progressPercent, status }`        |

### Server → Client
| Event               | Description                                      |
|---------------------|--------------------------------------------------|
| `vitals:update`     | New vitals reading with AI flags                 |
| `transfer:progress` | Transfer progress update                         |
| `transfer:created`  | New transfer request                             |
| `transfer:approval` | Approval decision broadcast                      |
| `alert:new`         | New critical alert                               |
| `alert:acknowledged`| Alert acknowledged by staff                      |
| `alert:resolved`    | Data quality recovered or vitals normalized      |
| `alert:escalated`   | Unacknowledged alert escalated to doctor/admin   |
| `bed:sensor`        | Synthetic bed telemetry every 2 seconds          |

---

## 🔑 Example API Requests

### Signup
```bash
curl -X POST http://localhost:5001/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "name":       "Dr. Ramesh Kumar",
    "email":      "ramesh@hospital.com",
    "password":   "SecurePass@123",
    "role":       "doctor",
    "department": "Critical Care"
  }'
```

### Login
```bash
curl -X POST http://localhost:5001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{ "email": "ramesh@hospital.com", "password": "SecurePass@123" }'
```

### Record Vitals (triggers AI prediction)
```bash
curl -X POST http://localhost:5001/api/patients/PATIENT_ID/vitals \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "heartRate":   108,
    "spo2":        93,
    "bpSystolic":  145,
    "bpDiastolic": 92
  }'
```

### Approve a Transfer
```bash
curl -X POST http://localhost:5001/api/transfers/TRANSFER_ID/approve \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{ "decision": "approved", "remarks": "Vitals stable, proceed." }'
```

### AI Predict (direct)
```bash
curl -X POST http://localhost:8000/predict \
  -H "Content-Type: application/json" \
  -d '{
    "heart_rate": 108, "spo2": 93,
    "bp_systolic": 145, "bp_diastolic": 92,
    "age": 67, "condition": "cardiac", "is_post_surgery": true
  }'
```

---

## 🔒 Role Permissions Summary

| Feature                  | Admin | Doctor | Nurse |
|--------------------------|:-----:|:------:|:-----:|
| View patients            | ✅    | ✅     | ✅    |
| Create / edit patient    | ✅    | ✅     | ❌    |
| Delete patient           | ✅    | ❌     | ❌    |
| Record vitals            | ✅    | ✅     | ✅    |
| Create transfer          | ✅    | ✅     | ✅    |
| Approve / reject transfer| ✅    | ✅     | ❌    |
| Update progress          | ✅    | ✅     | ✅    |
| Manage hospitals         | ✅    | ❌     | ❌    |
| Acknowledge alerts       | ✅    | ✅     | ✅    |

---

## 🤖 AI Service Details

The Python microservice uses a **Random Forest Classifier** trained on 5,000 synthetic patient records.

**Input features:**
- Heart Rate, SpO2, BP Systolic, BP Diastolic
- Age, Post-Surgery flag
- Medical Condition (cardiac, ICU, hydrocephalus, etc.)
- Derived: Pulse Pressure, Age Group

**Output:**
```json
{
  "risk":  "medium",
  "score": 0.73,
  "flags": { "hr_alert": true, "spo2_alert": false, "bp_alert": true },
  "raw_proba": { "high": 0.12, "low": 0.15, "medium": 0.73 }
}
```

> **If AI service is unavailable**, the Node backend automatically falls back to rule-based thresholds (HR > 100 → warn, SpO2 < 90 → critical).

---

## 🛠️ Environment Variables

```env
PORT=5000
NODE_ENV=development
MONGO_URI=mongodb://localhost:27017/medbed_os
JWT_SECRET=your_super_secret_key_here
JWT_EXPIRES_IN=7d
AI_SERVICE_URL=http://localhost:8000
CLIENT_ORIGIN=http://localhost:3000
```

---

## 📦 Tech Stack Summary

| Layer       | Technology                          |
|-------------|-------------------------------------|
| Frontend    | HTML + CSS + Vanilla JS (existing)  |
| Auth Pages  | login.html + signup.html            |
| Backend     | Node.js + Express                   |
| Database    | MongoDB + Mongoose                  |
| Real-time   | Socket.IO                           |
| Auth        | JWT (jsonwebtoken) + bcryptjs       |
| AI/ML       | Python + FastAPI + scikit-learn     |
| Validation  | express-validator                   |
| Security    | helmet, cors, bcrypt salt rounds=12 |
