# ai-service/model.py
# Loads the trained Risk Prediction model and exposes predict() + route_suggest()

import joblib
import numpy as np
import os

MODEL_PATH   = os.path.join(os.path.dirname(__file__), 'risk_model.pkl')
ENCODER_PATH = os.path.join(os.path.dirname(__file__), 'label_encoder.pkl')

CONDITION_MAP = {
    'general': 0, 'orthopaedic': 1, 'respiratory': 2,
    'hydrocephalus': 3, 'cardiac': 4, 'icu': 5,
}

FEATURE_COLS = [
    'heart_rate', 'spo2', 'bp_systolic', 'bp_diastolic',
    'age', 'is_post_surgery', 'condition_code',
    'pulse_pressure', 'age_group',
]


def _load_model():
    """Lazy-load model and encoder from disk."""
    if not os.path.exists(MODEL_PATH):
        raise FileNotFoundError(
            f"Model not found at {MODEL_PATH}. Run 'python train.py' first."
        )
    model   = joblib.load(MODEL_PATH)
    encoder = joblib.load(ENCODER_PATH)
    return model, encoder


# ── predict ───────────────────────────────────────────────────────────────────

def predict(
    heart_rate: int,
    spo2: int,
    bp_systolic: int,
    bp_diastolic: int,
    age: int,
    condition: str,
    is_post_surgery: bool,
) -> dict:
    """
    Returns:
        {
            risk:   'low' | 'medium' | 'high',
            score:  float (0–1, probability of predicted class),
            flags: { hr_alert, spo2_alert, bp_alert }
        }
    """
    model, encoder = _load_model()

    condition_code = CONDITION_MAP.get(condition, 0)
    pulse_pressure = bp_systolic - bp_diastolic
    age_group      = 0 if age < 40 else 1 if age < 60 else 2 if age < 75 else 3

    features = np.array([[
        heart_rate, spo2, bp_systolic, bp_diastolic,
        age, int(is_post_surgery), condition_code,
        pulse_pressure, age_group,
    ]])

    pred_encoded = model.predict(features)[0]
    proba        = model.predict_proba(features)[0]
    risk_label   = encoder.inverse_transform([pred_encoded])[0]   # 'low'/'medium'/'high'
    confidence   = float(round(proba.max(), 4))

    flags = {
        'hr_alert':   heart_rate  > 100,
        'spo2_alert': spo2        < 94,
        'bp_alert':   bp_systolic > 140,
    }

    return {
        'risk':       risk_label,
        'score':      confidence,
        'flags':      flags,
        'raw_proba':  {cls: float(round(p, 4)) for cls, p in zip(encoder.classes_, proba)},
    }


# ── route_suggest ─────────────────────────────────────────────────────────────
# Simple heuristic route engine (can be upgraded to A* or ML later)

ELEVATOR_MAP = {
    (1, 2): 'Elevator A', (1, 3): 'Elevator A', (1, 4): 'Elevator B',
    (2, 3): 'Elevator A', (2, 4): 'Elevator B', (3, 4): 'Elevator B',
}

def suggest_route(from_ward: str, to_ward: str) -> dict:
    """
    Returns a plain-English route suggestion and estimated time.
    In production, integrate with real hospital floor map / IoT occupancy data.
    """
    route_steps = [from_ward, 'Corridor B']

    # Pick elevator based on destination floor (simple heuristic)
    dest_floor = 4  # default ICU floor
    elev       = 'Elevator B'
    for (f, t), e in ELEVATOR_MAP.items():
        if str(f) in from_ward or str(t) in to_ward:
            elev       = e
            dest_floor = t
            break

    route_steps += [elev, f'Floor {dest_floor}', to_ward]
    route_str    = ' → '.join(route_steps)
    est_minutes  = 8 + len(route_steps) * 1  # rough estimate

    return {
        'route':            route_str,
        'elevator':         elev,
        'estimated_minutes': est_minutes,
        'avoid':            'Elevator A (crowded)' if elev == 'Elevator B' else '',
    }
