# ai-service/api.py
# FastAPI microservice — exposes /predict and /route to the Node.js backend
#
# Start: uvicorn api:app --host 0.0.0.0 --port 8000 --reload

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field, validator
from typing import Optional
import traceback

from model import predict, suggest_route

app = FastAPI(
    title="MedBed OS — AI Risk Service",
    description="Predicts patient transfer risk and suggests optimal hospital routes.",
    version="1.0.0",
)


# ── Request / Response schemas ────────────────────────────────────────────────

class VitalsInput(BaseModel):
    heart_rate:      int   = Field(..., ge=30,  le=250,  description="Heart rate in bpm")
    spo2:            int   = Field(..., ge=60,  le=100,  description="SpO2 percentage")
    bp_systolic:     int   = Field(..., ge=60,  le=250,  description="Systolic BP mmHg")
    bp_diastolic:    int   = Field(..., ge=30,  le=150,  description="Diastolic BP mmHg")
    age:             int   = Field(..., ge=0,   le=120,  description="Patient age in years")
    condition:       str   = Field('general',            description="Medical condition category")
    is_post_surgery: bool  = Field(False,                description="Post-surgery flag")

    @validator('condition')
    def validate_condition(cls, v):
        allowed = {'general','cardiac','hydrocephalus','icu','respiratory','orthopaedic'}
        if v not in allowed:
            return 'general'
        return v


class PredictionResponse(BaseModel):
    risk:      str
    score:     float
    flags:     dict
    raw_proba: dict


class RouteInput(BaseModel):
    from_ward: str
    to_ward:   str


class RouteResponse(BaseModel):
    route:             str
    elevator:          str
    estimated_minutes: int
    avoid:             Optional[str]


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {"service": "MedBed AI Risk Engine", "status": "running"}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/predict", response_model=PredictionResponse)
def predict_risk(data: VitalsInput):
    """
    Accepts patient vitals + context, returns risk level and alert flags.
    Called by Node.js backend on every vitals recording.
    """
    try:
        result = predict(
            heart_rate      = data.heart_rate,
            spo2            = data.spo2,
            bp_systolic     = data.bp_systolic,
            bp_diastolic    = data.bp_diastolic,
            age             = data.age,
            condition       = data.condition,
            is_post_surgery = data.is_post_surgery,
        )
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=503, detail=str(e) + " — Run train.py first.")
    except Exception:
        raise HTTPException(status_code=500, detail=traceback.format_exc())


@app.post("/route", response_model=RouteResponse)
def get_route(data: RouteInput):
    """
    Returns the optimal transfer route between two wards.
    """
    try:
        result = suggest_route(data.from_ward, data.to_ward)
        return result
    except Exception:
        raise HTTPException(status_code=500, detail=traceback.format_exc())
