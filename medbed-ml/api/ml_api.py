"""
api/ml_api.py
─────────────────────────────────────────────────────────────────────────────
FastAPI ML microservice exposing all 3 MedBed OS prediction models.
Connected to Node.js backend via HTTP.

Start:
    uvicorn api.ml_api:app --host 0.0.0.0 --port 8000 --reload

Endpoints:
    POST /predict/transfer
    POST /predict/vitals
    POST /predict/safety
    POST /predict/all        ← combined single call
    GET  /health
    GET  /metrics
"""

import time
import logging
from pathlib import Path
from typing import List, Optional
from collections import defaultdict

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, validator

# ── Model imports ─────────────────────────────────────────────────────────────
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from models.transfer.train_transfer_model import TransferPredictor
from models.vitals.train_vitals_model     import VitalsPredictor
from models.safety.train_safety_model     import SafetyPredictor

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s [%(levelname)s] %(message)s')
log = logging.getLogger('medbed-ml')

# ── FastAPI app ───────────────────────────────────────────────────────────────
app = FastAPI(
    title       = 'MedBed OS — ML Prediction Service',
    description = 'Real-time predictions for patient transfer safety',
    version     = '1.0.0',
)

app.add_middleware(CORSMiddleware,
    allow_origins  = ['*'],
    allow_methods  = ['GET', 'POST'],
    allow_headers  = ['*'],
)

# ── Lazy-load predictors once on startup ─────────────────────────────────────
predictors: dict = {}
inference_stats   = defaultdict(list)   # latency tracking

MODEL_DIR = Path(__file__).parent.parent / 'models'

@app.on_event('startup')
def load_models():
    log.info('⏳  Loading ML models…')
    try:
        predictors['transfer'] = TransferPredictor(MODEL_DIR / 'transfer')
        log.info('✅  Transfer model loaded')
    except Exception as e:
        log.warning(f'⚠️  Transfer model not found: {e}. Train it first.')

    try:
        predictors['vitals'] = VitalsPredictor(MODEL_DIR / 'vitals')
        log.info('✅  Vitals model loaded')
    except Exception as e:
        log.warning(f'⚠️  Vitals model not found: {e}. Train it first.')

    try:
        predictors['safety'] = SafetyPredictor(MODEL_DIR / 'safety')
        log.info('✅  Safety model loaded')
    except Exception as e:
        log.warning(f'⚠️  Safety model not found: {e}. Train it first.')

    log.info(f'🚀  {len(predictors)}/3 models ready')


# ══════════════════════════════════════════════════════════════════════════════
# Request / Response schemas
# ══════════════════════════════════════════════════════════════════════════════

class TransferRequest(BaseModel):
    age:               int   = Field(..., ge=0, le=120)
    weight_kg:         float = Field(..., ge=5, le=300)
    condition:         int   = Field(..., ge=0, le=4,
                                    description='0=General,1=Cardiac,2=Respiratory,3=Neuro,4=ICU')
    department_from:   int   = Field(..., ge=0, le=4)
    department_to:     int   = Field(..., ge=0, le=4)
    heart_rate:        int   = Field(..., ge=20, le=250)
    spo2:              int   = Field(..., ge=50, le=100)
    bp_systolic:       int   = Field(..., ge=50, le=260)
    bp_diastolic:      int   = Field(..., ge=20, le=160)
    transfer_distance: float = Field(..., ge=0, le=2000)
    time_of_day:       int   = Field(..., ge=0, le=23)
    is_post_surgery:   int   = Field(0, ge=0, le=1)
    equipment_count:   int   = Field(0, ge=0, le=10)

    class Config:
        json_schema_extra = {
            'example': {
                'age': 67, 'weight_kg': 78.5, 'condition': 1,
                'department_from': 0, 'department_to': 1,
                'heart_rate': 102, 'spo2': 96,
                'bp_systolic': 128, 'bp_diastolic': 82,
                'transfer_distance': 180.0, 'time_of_day': 14,
                'is_post_surgery': 1, 'equipment_count': 2,
            }
        }


class VitalsRequest(BaseModel):
    heart_rate:      List[int]   = Field(..., min_items=1, max_items=20)
    spo2:            List[int]   = Field(..., min_items=1, max_items=20)
    blood_pressure:  List[int]   = Field(..., min_items=1, max_items=20)
    age:             int         = Field(60, ge=0, le=120)
    condition:       int         = Field(0,  ge=0, le=4)
    is_post_surgery: int         = Field(0,  ge=0, le=1)

    @validator('heart_rate', each_item=True)
    def validate_hr(cls, v):
        if not 20 <= v <= 250: raise ValueError('HR out of range')
        return v

    @validator('spo2', each_item=True)
    def validate_spo2(cls, v):
        if not 50 <= v <= 100: raise ValueError('SpO2 out of range')
        return v

    class Config:
        json_schema_extra = {
            'example': {
                'heart_rate':     [88,92,95,98,102,104,105,107,108,110],
                'spo2':           [97,97,96,96,95,95,94,94,93,93],
                'blood_pressure': [118,120,122,124,126,128,130,131,132,133],
                'age': 67, 'condition': 1, 'is_post_surgery': 1,
            }
        }


class SafetyRequest(BaseModel):
    weight_kg:         float = Field(..., ge=5,  le=300)
    age:               int   = Field(..., ge=0,  le=120)
    is_sedated:        int   = Field(0,   ge=0,  le=1)
    sensor_head:       float = Field(..., ge=0,  le=200)
    sensor_torso:      float = Field(..., ge=0,  le=200)
    sensor_leg_left:   float = Field(..., ge=0,  le=200)
    sensor_leg_right:  float = Field(..., ge=0,  le=200)
    sensor_foot:       float = Field(..., ge=0,  le=200)
    accel_x:           float = Field(0.0)
    accel_y:           float = Field(0.0)
    accel_z:           float = Field(9.81)
    gyro_roll:         float = Field(0.0, ge=-180, le=180)
    gyro_pitch:        float = Field(0.0, ge=-90,  le=90)
    rail_left_locked:  int   = Field(1, ge=0, le=1)
    rail_right_locked: int   = Field(1, ge=0, le=1)
    bed_angle:         float = Field(30.0, ge=0, le=90)
    movement_30s:      int   = Field(0,    ge=0, le=100)

    class Config:
        json_schema_extra = {
            'example': {
                'weight_kg': 78.5, 'age': 67, 'is_sedated': 0,
                'sensor_head': 8.2, 'sensor_torso': 38.1,
                'sensor_leg_left': 16.4, 'sensor_leg_right': 14.8,
                'sensor_foot': 1.0,
                'accel_x': 0.05, 'accel_y': 0.02, 'accel_z': 9.80,
                'gyro_roll': 3.2, 'gyro_pitch': 1.1,
                'rail_left_locked': 0, 'rail_right_locked': 1,
                'bed_angle': 30.0, 'movement_30s': 4,
            }
        }


class CombinedRequest(BaseModel):
    transfer: Optional[TransferRequest] = None
    vitals:   Optional[VitalsRequest]   = None
    safety:   Optional[SafetyRequest]   = None


# ══════════════════════════════════════════════════════════════════════════════
# Helper
# ══════════════════════════════════════════════════════════════════════════════

def get_predictor(name: str):
    if name not in predictors:
        raise HTTPException(
            status_code = 503,
            detail      = f'{name} model not loaded. Run train_{name}_model.py first.'
        )
    return predictors[name]


def timed_predict(name: str, fn):
    t0     = time.perf_counter()
    result = fn()
    ms     = (time.perf_counter() - t0) * 1000
    inference_stats[name].append(ms)
    result['inference_ms'] = round(ms, 2)
    return result


# ══════════════════════════════════════════════════════════════════════════════
# Endpoints
# ══════════════════════════════════════════════════════════════════════════════

@app.get('/', tags=['Health'])
def root():
    return {'service': 'MedBed OS ML Service', 'models_loaded': list(predictors.keys())}


@app.get('/health', tags=['Health'])
def health():
    return {
        'status':        'ok',
        'models_loaded': list(predictors.keys()),
        'models_ready':  len(predictors),
    }


@app.get('/metrics', tags=['Monitoring'])
def metrics():
    """Returns average inference latency per model."""
    return {
        model: {
            'calls':     len(times),
            'avg_ms':    round(sum(times) / len(times), 2) if times else 0,
            'max_ms':    round(max(times), 2) if times else 0,
        }
        for model, times in inference_stats.items()
    }


@app.post('/predict/transfer', tags=['Transfer'])
def predict_transfer(req: TransferRequest):
    """
    Predicts: staff_count, risk_level, estimated_minutes
    """
    pred = get_predictor('transfer')
    return timed_predict('transfer',
        lambda: pred.predict(req.dict()))


@app.post('/predict/vitals', tags=['Vitals'])
def predict_vitals(req: VitalsRequest):
    """
    Predicts: alert_class, deterioration_prob
    """
    pred = get_predictor('vitals')
    return timed_predict('vitals',
        lambda: pred.predict(
            hr             = req.heart_rate,
            spo2           = req.spo2,
            bp             = req.blood_pressure,
            age            = req.age,
            condition      = req.condition,
            is_post_surgery= req.is_post_surgery,
        ))


@app.post('/predict/safety', tags=['Safety'])
def predict_safety(req: SafetyRequest):
    """
    Predicts: fall_risk_prob, imbalance_detected, safety_alert
    """
    pred = get_predictor('safety')
    return timed_predict('safety',
        lambda: pred.predict(req.dict()))


@app.post('/predict/all', tags=['Combined'])
def predict_all(req: CombinedRequest):
    """
    Combined endpoint — run any combination of models in one call.
    Only included models are run; missing ones return null.
    """
    result = {}
    if req.transfer:
        try:
            result['transfer'] = timed_predict('transfer',
                lambda: get_predictor('transfer').predict(req.transfer.dict()))
        except Exception as e:
            result['transfer'] = {'error': str(e)}

    if req.vitals:
        try:
            v = req.vitals
            result['vitals'] = timed_predict('vitals',
                lambda: get_predictor('vitals').predict(
                    v.heart_rate, v.spo2, v.blood_pressure,
                    v.age, v.condition, v.is_post_surgery))
        except Exception as e:
            result['vitals'] = {'error': str(e)}

    if req.safety:
        try:
            result['safety'] = timed_predict('safety',
                lambda: get_predictor('safety').predict(req.safety.dict()))
        except Exception as e:
            result['safety'] = {'error': str(e)}

    return result
