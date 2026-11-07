# Care-Verse 🏥
### AI-Powered Smart Healthcare & Patient Transfer Platform

> **Ward Zero prototype status:** this repository now contains a working
> synthetic demo slice: backend JWT auth, patient/vitals ingestion, offline
> sensor replay buffer with bounded exponential backoff and dead-lettering,
> current-state AI risk assessment with a tagged rule fallback, explainable alerts,
> acknowledge/dismiss/escalate/audit workflows, stale/offline detection, named
> sensor scenarios, and a dashboard wired to REST/Socket.IO. The test suite includes
> 34/34 automated backend unit/safety tests (`npm test`) and a reproducible committed
> Playwright Core browser suite (41/41 checks passed via `npm run test:e2e`),
> including mobile 390x844 layout, stale/offline safety states, alert
> ACK/dismiss/L2 escalation, and no-data patient behavior. Run all tests with
> `npm run test:all` (75/75 passed). See [`CONTEXT.md`](CONTEXT.md) for the verified
> scope, commands, and known gaps. This is not a clinically validated system. Some
> sections below are inherited marketing copy; do not quote unmeasured performance claims.

## Ward Zero quick start

Requirements: Node.js, Python 3.11, and a MongoDB URI (Atlas is verified).

```bash
# 1. AI service (optional; otherwise the backend uses tagged rule fallback)
cd medbed-fullstack/ai-service
python3.11 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python train.py
uvicorn api:app --host 127.0.0.1 --port 8000

# 2. Backend (use 5001 on macOS because AirPlay owns 5000)
cd medbed-fullstack/backend
npm install
cp .env.example .env
# Set MONGO_URI, JWT_SECRET, PORT=5001 in .env. Never commit .env.
npm test            # 34/34 unit and safety tests
npm run test:e2e    # 41/41 Playwright browser checks
npm run test:all    # 75/75 full test suite
npm run seed
npm start

# 3. Open the backend-served dashboard
# http://127.0.0.1:5001/login.html
```

Synthetic demo accounts created by `npm run seed` are
`admin@careverse.com`, `doctor@careverse.com`, and `nurse@careverse.com` with
password `WardZero!2026` (override with `DEMO_PASSWORD`). Use synthetic data
only.

---

Care-Verse is a full-stack healthcare technology platform designed to improve **patient monitoring, risk assessment, hospital coordination, and patient transfers** through a combination of real-time systems, artificial intelligence, and modern web technologies.
The platform brings together patient data, live vitals, AI-based risk prediction, transfer management, alerts, and role-based healthcare workflows into a unified system.
---
## 🚀 Overview
Healthcare teams often need to make rapid decisions while managing patient vitals, transfers, alerts, and coordination between departments or hospitals.
**Care-Verse** addresses this challenge by providing a centralized platform that enables healthcare staff to:
- Monitor patients and their vital signs in real time
- Predict potential patient risks using AI/ML
- Generate alerts for abnormal vitals
- Create and manage patient transfer requests
- Handle transfer approvals and progress
- Coordinate inter-hospital transfers
- Manage healthcare staff with role-based permissions
- Maintain an auditable workflow for critical decisions
- Connect frontend, backend, database, and AI services into one system
---
## 🧠 Core Idea
```text
                    ┌─────────────────────┐
                    │      CARE-VERSE     │
                    │ Smart Healthcare     │
                    │     Platform        │
                    └──────────┬──────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
   Patient Monitoring      AI Risk Engine      Transfer System
          │                    │                    │
          ▼                    ▼                    ▼
      Live Vitals         Risk Prediction       Approvals
      Alerts              Risk Score             Progress
      Patient Data        Risk Flags             Hospitals
          │                    │                    │
          └────────────────────┼────────────────────┘
                               ▼
                      Healthcare Dashboard

⸻

✨ Key Features

👨‍⚕️ Patient Management

Healthcare staff can manage patient information and access patient-specific data through a centralized dashboard.

Features include:

* Patient registration
* Patient records
* Patient vitals
* Medical conditions
* Patient risk information
* Historical vital readings

⸻

❤️ Real-Time Patient Monitoring

Care-Verse supports real-time monitoring of patient vitals using Socket.IO.

Supported parameters include:

* Heart Rate
* SpO₂
* Blood Pressure
* Other patient monitoring metrics

Abnormal readings can trigger AI analysis and system alerts.

⸻

🤖 AI Risk Prediction

The platform includes a dedicated Python-based AI microservice for patient risk prediction.

The AI service uses:

* Python
* FastAPI
* Scikit-learn
* Random Forest Classification

The model analyzes patient information and vital signs to estimate risk levels such as:

LOW
MEDIUM
HIGH

It also provides:

* Risk score
* Vital abnormality flags
* Probability distribution
* Transfer-related risk information

AI Pipeline

Patient Data
     │
     ▼
Vital Signs + Medical Information
     │
     ▼
Feature Engineering
     │
     ▼
Machine Learning Model
     │
     ▼
Risk Prediction
     │
     ├── Risk Level
     ├── Risk Score
     └── Alert Flags

The system also includes a rule-based fallback mechanism if the AI service becomes unavailable.

⸻

🚑 Smart Patient Transfer

Care-Verse provides a structured workflow for managing patient transfers.

Transfer Request
       │
       ▼
   AI Risk Check
       │
       ▼
Approval Required
       │
   ┌───┴────┐
   ▼        ▼
Approved  Rejected
   │
   ▼
Transfer In Progress
   │
   ▼
Completed

The transfer system supports:

* Transfer creation
* Transfer approval/rejection
* Transfer progress tracking
* Transfer status management
* Hospital coordination
* Audit trails

⸻

🔔 Intelligent Alerts

The system generates alerts based on patient conditions and AI predictions.

Alerts can be generated for:

* Abnormal heart rate
* Low SpO₂
* Abnormal blood pressure
* High patient risk
* Transfer-related events
* Critical system conditions

Healthcare staff can acknowledge or dismiss alerts according to their permissions.

⸻

🔐 Authentication & Role-Based Access

Care-Verse uses secure authentication and authorization mechanisms.

Authentication

* JWT-based authentication
* Password hashing using bcrypt
* Protected API routes
* Token-based sessions
* Role-based authorization

User Roles

Role	Capabilities
Admin	Full system access
Doctor	Patient management, approvals, monitoring
Nurse	Monitoring, vitals, transfers, alerts

Permissions are enforced at the backend level.

⸻

⚡ Real-Time Architecture

The platform uses Socket.IO to provide real-time communication between the frontend and backend.

Real-time events include:

Patient Vitals
     ↓
Backend
     ↓
AI Analysis
     ↓
Risk / Alert Generation
     ↓
Socket.IO
     ↓
Connected Dashboards

This allows multiple healthcare users to receive important patient and transfer updates without manually refreshing the dashboard.

⸻

🏗️ System Architecture

                         CARE-VERSE
                              │
             ┌────────────────┼────────────────┐
             │                │                │
             ▼                ▼                ▼
        Frontend           Backend          AI Service
      HTML/CSS/JS       Node + Express      Python/FastAPI
             │                │                │
             │                ├───────► AI ───┤
             │                │
             │                ▼
             │            MongoDB
             │
             ▼
       Healthcare Users

Technology Flow

Frontend
   │
   │ REST API / Socket.IO
   ▼
Node.js + Express Backend
   │
   ├──────────────► MongoDB
   │
   └──────────────► Python AI Service
                         │
                         ▼
                  ML Risk Prediction

⸻

🛠️ Technology Stack

Layer	Technology
Frontend	HTML, CSS, JavaScript
Backend	Node.js, Express.js
Database	MongoDB, Mongoose
Real-Time	Socket.IO
Authentication	JWT, bcryptjs
AI/ML	Python, Scikit-learn
AI API	FastAPI
Validation	Express Validator
Security	Helmet, CORS
ML Model	Random Forest Classifier

⸻

📁 Repository Structure

Care-Verse/
│
├── bed/
│   └── Bed monitoring / sensor components
│
├── medbed-fullstack/
│   │
│   ├── backend/
│   │   ├── config/
│   │   ├── controllers/
│   │   ├── middleware/
│   │   ├── models/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── sockets/
│   │   └── server.js
│   │
│   ├── ai-service/
│   │   ├── train.py
│   │   ├── model.py
│   │   ├── api.py
│   │   └── requirements.txt
│   │
│   └── frontend/
│       ├── login.html
│       ├── signup.html
│       ├── auth.js
│       └── index.html
│
├── medbed-ml/
│   └── Machine learning components
│
├── package.json
├── package-lock.json
├── README.md
└── .gitignore

⸻

🔄 End-to-End Workflow

A typical Care-Verse workflow looks like:

1. Healthcare staff logs in
             ↓
2. Staff accesses patient dashboard
             ↓
3. Patient vitals are recorded
             ↓
4. Backend processes the readings
             ↓
5. AI service evaluates patient risk
             ↓
6. Risk score and alerts are generated
             ↓
7. Healthcare staff receives real-time updates
             ↓
8. Transfer request can be created
             ↓
9. Authorized staff approves/rejects transfer
             ↓
10. Transfer progress is tracked
             ↓
11. Transfer is completed

⸻

📊 Data & AI

The AI component is designed around patient physiological and contextual information.

Example Input

Heart Rate
SpO₂
Blood Pressure
Age
Medical Condition
Post-Surgery Status

Example Output

{
  "risk": "medium",
  "score": 0.73,
  "flags": {
    "hr_alert": true,
    "spo2_alert": false,
    "bp_alert": true
  }
}

The model can be trained using synthetic patient records and provides a foundation for future integration with real-world clinical datasets.

Note: AI predictions are intended as decision-support signals and should not replace professional clinical judgment.

⸻

🔒 Security

Security is an important part of the platform.

Care-Verse implements:

* JWT authentication
* Password hashing
* Protected routes
* Role-based authorization
* HTTP security headers
* CORS configuration
* Input validation
* Environment-based configuration
* Separation of AI and backend services

Sensitive configuration such as database credentials and JWT secrets should be stored in environment variables and must not be committed to GitHub.

⸻

⚙️ Local Development

Prerequisites

Make sure you have:

* Node.js 18+
* Python 3.9+
* MongoDB
* npm
* Git

⸻

1. Clone Repository

git clone https://github.com/tanmayyyyayyy/Care-Verse.git
cd Care-Verse

⸻

2. Start Backend

cd medbed-fullstack/backend
npm install
cp .env.example .env

Configure your .env file:

PORT=5000
NODE_ENV=development
MONGO_URI=mongodb://localhost:27017/medbed_os
JWT_SECRET=your_secret_key
JWT_EXPIRES_IN=7d
AI_SERVICE_URL=http://localhost:8000
CLIENT_ORIGIN=http://localhost:3000

Start the backend:

npm run dev

Backend:

http://localhost:5000

⸻

3. Start AI Service

Open another terminal:

cd medbed-fullstack/ai-service
python -m venv venv
source venv/bin/activate

Windows:

venv\Scripts\activate

Install dependencies:

pip install -r requirements.txt

Train the model:

python train.py

Start the AI service:

uvicorn api:app --host 0.0.0.0 --port 8000 --reload

AI API:

http://localhost:8000

Swagger documentation:

http://localhost:8000/docs

⸻

🌐 Application Components

Component	Default Address
Frontend	Local HTML application
Backend API	localhost:5000
AI Service	localhost:8000
MongoDB	localhost:27017

⸻

🧪 API & Developer Documentation

Detailed API documentation, authentication flows, Socket.IO events, database collections, environment variables, and example requests are available inside:

medbed-fullstack/README.md

⸻

🚧 Future Roadmap

Potential future improvements include:

* Real hospital/EMR integrations
* Advanced clinical datasets
* Deep learning-based risk prediction
* Predictive deterioration analysis
* Automated bed allocation
* Hospital capacity monitoring
* GPS-based ambulance tracking
* Multi-hospital coordination
* Advanced analytics dashboards
* Mobile application
* Notification services
* Explainable AI
* Cloud deployment
* Containerized deployment using Docker
* Comprehensive automated testing

⸻

🎯 Vision

Care-Verse aims to move healthcare workflows from reactive monitoring toward proactive, intelligent decision support.

By combining:

Real-Time Monitoring + AI + Automation + Healthcare Workflows

the platform provides a foundation for smarter patient management and safer, more coordinated transfers.

⸻

👨‍💻 Project

Care-Verse

AI-powered healthcare and smart patient transfer platform.

Developed by Tanmay Jain

⸻

⭐ Support

If you find this project interesting, consider giving the repository a ⭐ on GitHub.

Care-Verse
AI • Healthcare • Machine Learning • Real-Time Systems
