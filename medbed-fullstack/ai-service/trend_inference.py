# ai-service/trend_inference.py
"""
Trend Deterioration Inference Engine
Loads trend_model.pkl and trend_features.json to evaluate time-series vitals windows.
Computes ranked human-readable contributing factors.
Rejects insufficient, stale, or offline data with 'insufficient_data' status.
Includes rule-based fallback when ML model is unavailable.
"""

import os
import json
import joblib
import numpy as np
from datetime import datetime, timezone
from typing import List, Dict, Any, Optional

from train_trend import extract_window_features, compute_news2

MODEL_PATH = os.path.join(os.path.dirname(__file__), 'trend_model.pkl')
FEATURES_PATH = os.path.join(os.path.dirname(__file__), 'trend_features.json')

_model = None
_features = None


def _load_trend_model():
    global _model, _features
    if _model is None and os.path.exists(MODEL_PATH) and os.path.exists(FEATURES_PATH):
        try:
            _model = joblib.load(MODEL_PATH)
            with open(FEATURES_PATH, 'r') as f:
                _features = json.load(f)
        except Exception as e:
            print(f"[TrendInference] Failed to load ML model: {e}")
            _model = None
            _features = None
    return _model, _features


def rule_trend_fallback(readings: List[Dict[str, Any]], baseline: Dict[str, Any], patient_context: Dict[str, Any], horizon_hours: int = 48) -> Dict[str, Any]:
    """
    Transparent rule-based fallback for trend risk assessment.
    """
    hrs = [r['heart_rate'] for r in readings]
    spo2s = [r['spo2'] for r in readings]
    bps = [r['bp_systolic'] for r in readings]
    rrs = [r.get('respiratory_rate', 16) for r in readings]
    temps = [r.get('temperature', 37.0) for r in readings]

    news_scores = [compute_news2(h, s, b, r, t) for h, s, b, r, t in zip(hrs, spo2s, bps, rrs, temps)]
    latest_news = news_scores[-1]
    max_news = max(news_scores)

    base_hr = baseline.get('heart_rate', 75.0)
    base_spo2 = baseline.get('spo2', 98.0)
    base_rr = baseline.get('respiratory_rate', 16.0)

    delta_hr = hrs[-1] - base_hr
    delta_spo2 = spo2s[-1] - base_spo2
    delta_rr = rrs[-1] - base_rr

    contributing = []
    risk_level = 'low'
    risk_score = 0.20

    if max_news >= 7 or spo2s[-1] < 90 or delta_spo2 <= -6.0 or delta_rr >= 10:
        risk_level = 'high'
        risk_score = 0.88
    elif max_news >= 4 or spo2s[-1] < 94 or delta_spo2 <= -3.0 or delta_rr >= 6:
        risk_level = 'medium'
        risk_score = 0.55

    if delta_spo2 < 0:
        contributing.append(f"SpO2 decreased by {abs(delta_spo2):.1f}% from baseline ({base_spo2}%)")
    if delta_rr > 3:
        contributing.append(f"Respiratory rate increased by +{delta_rr:.0f} breaths/min above baseline")
    if delta_hr > 15:
        contributing.append(f"Heart rate elevated (+{delta_hr:.0f} bpm above baseline)")
    if latest_news >= 4:
        contributing.append(f"NEWS2 aggregate score reached {latest_news} (peak: {max_news})")

    if not contributing:
        contributing.append("Vitals trajectory within normal baseline variation")

    return {
        'risk_score': risk_score,
        'risk_level': risk_level,
        'horizon_hours': horizon_hours,
        'top_contributing_factors': contributing[:4],
        'confidence': 0.75,
        'source': 'rule',
        'safety_notice': 'Experimental — synthetic data only. Rule-based trend evaluation (ML model offline).',
    }


def predict_trend(
    readings: List[Dict[str, Any]],
    baseline: Optional[Dict[str, Any]] = None,
    patient_context: Optional[Dict[str, Any]] = None,
    horizon_hours: int = 48,
) -> Dict[str, Any]:
    """
    Main entry point for 24-48h deterioration trend assessment.
    """
    if baseline is None:
        baseline = {}
    if patient_context is None:
        patient_context = {}

    # 1. Minimum continuous readings check
    if not readings or len(readings) < 5:
        count = len(readings) if readings else 0
        return {
            'risk_score': None,
            'risk_level': 'insufficient_data',
            'horizon_hours': horizon_hours,
            'top_contributing_factors': [
                f"Insufficient data: minimum 5 continuous readings required for trend projection (received {count})"
            ],
            'confidence': 0.0,
            'source': 'rule',
            'safety_notice': 'Experimental — synthetic data only. Insufficient data; do not assume patient is stable.',
        }

    # 2. Check for staleness/offline gap if timestamps exist
    # If the latest reading is older than 3 hours relative to reference time
    latest_reading = readings[-1]
    if 'timestamp' in latest_reading and latest_reading['timestamp']:
        try:
            ts_str = str(latest_reading['timestamp']).replace('Z', '+00:00')
            last_dt = datetime.fromisoformat(ts_str)
            now_dt = datetime.now(timezone.utc)
            # If timestamp timezone is naive, make utc
            if last_dt.tzinfo is None:
                last_dt = last_dt.replace(tzinfo=timezone.utc)
            age_sec = (now_dt - last_dt).total_seconds()
            if age_sec > 10800:  # > 3 hours
                return {
                    'risk_score': None,
                    'risk_level': 'insufficient_data',
                    'horizon_hours': horizon_hours,
                    'top_contributing_factors': [
                        f"Sensor offline or stale data ({int(age_sec // 3600)}h since last reading); trend cannot be computed"
                    ],
                    'confidence': 0.0,
                    'source': 'rule',
                    'safety_notice': 'Experimental — synthetic data only. Stale sensor data; do not assume patient is stable.',
                }
        except Exception:
            pass  # If timestamp parsing fails, proceed with t_hours sequence

    # Normalize t_hours
    normalized_readings = []
    base_t = 0.0
    for idx, r in enumerate(readings):
        t_val = r.get('t_hours')
        if t_val is None:
            t_val = float(idx)
        normalized_readings.append({
            't_hours': float(t_val),
            'heart_rate': float(r['heart_rate']),
            'spo2': float(r['spo2']),
            'bp_systolic': float(r['bp_systolic']),
            'bp_diastolic': float(r['bp_diastolic'] if r.get('bp_diastolic') is not None else r['bp_systolic'] * 0.62),
            'respiratory_rate': float(r['respiratory_rate'] if r.get('respiratory_rate') is not None else 16),
            'temperature': float(r['temperature'] if r.get('temperature') is not None else 37.0),
        })

    # 3. Extract features
    features = extract_window_features(normalized_readings, baseline, patient_context)
    if features is None:
        return {
            'risk_score': None,
            'risk_level': 'insufficient_data',
            'horizon_hours': horizon_hours,
            'top_contributing_factors': ["Insufficient data points across time window"],
            'confidence': 0.0,
            'source': 'rule',
            'safety_notice': 'Experimental — synthetic data only. Insufficient data; do not assume patient is stable.',
        }

    # 4. Attempt ML inference
    model, feature_names = _load_trend_model()
    if model is None or feature_names is None:
        return rule_trend_fallback(normalized_readings, baseline, patient_context, horizon_hours)

    try:
        X = np.array([[features.get(f, 0.0) for f in feature_names]])
        pred_label = model.predict(X)[0]
        proba = model.predict_proba(X)[0]
        classes = list(model.classes_)
        class_idx = classes.index(pred_label)
        confidence = float(round(proba[class_idx], 4))

        # Risk score calibrated to severity (0.0 to 1.0)
        # high weight 1.0, medium weight 0.55, low weight 0.15
        p_high = proba[classes.index('high')] if 'high' in classes else 0.0
        p_med = proba[classes.index('medium')] if 'medium' in classes else 0.0
        p_low = proba[classes.index('low')] if 'low' in classes else 0.0
        risk_score = float(round(p_high * 1.0 + p_med * 0.55 + p_low * 0.15, 3))

        # 5. Extract top ranked human-readable contributing factors
        factors = []
        span_h = max(1.0, normalized_readings[-1]['t_hours'] - normalized_readings[0]['t_hours'])

        if abs(features['spo2_slope']) >= 0.05:
            sign = "+" if features['spo2_slope'] > 0 else ""
            factors.append((
                abs(features['spo2_slope']) * 3.0,
                f"SpO2 slope {sign}{features['spo2_slope']:.2f}%/h over {span_h:.1f}h"
            ))

        if abs(features['rr_slope']) >= 0.1:
            sign = "+" if features['rr_slope'] > 0 else ""
            factors.append((
                abs(features['rr_slope']) * 2.5,
                f"Respiratory rate slope {sign}{features['rr_slope']:.2f} breaths/min/h over {span_h:.1f}h"
            ))

        if abs(features['hr_slope']) >= 0.2:
            sign = "+" if features['hr_slope'] > 0 else ""
            factors.append((
                abs(features['hr_slope']) * 1.5,
                f"Heart rate slope {sign}{features['hr_slope']:.2f} bpm/h over {span_h:.1f}h"
            ))

        if features['news_max'] >= 4:
            factors.append((
                features['news_max'] * 1.2,
                f"NEWS2 rolling aggregate reached {int(features['news_latest'])} (peak: {int(features['news_max'])})"
            ))

        if features['hours_spo2_below_92'] > 0.5:
            factors.append((
                features['hours_spo2_below_92'] * 2.0,
                f"SpO2 spent {features['hours_spo2_below_92']:.1f}h below 92%"
            ))

        if features['hours_sys_below_90'] > 0.5:
            factors.append((
                features['hours_sys_below_90'] * 2.5,
                f"Systolic BP spent {features['hours_sys_below_90']:.1f}h below 90 mmHg"
            ))

        if abs(features['rr_delta_baseline']) >= 4.0:
            sign = "+" if features['rr_delta_baseline'] > 0 else ""
            factors.append((
                abs(features['rr_delta_baseline']) * 1.2,
                f"Respiratory rate {sign}{features['rr_delta_baseline']:.0f} breaths/min from baseline ({baseline.get('respiratory_rate', 16)})"
            ))

        if abs(features['hr_delta_baseline']) >= 12.0:
            sign = "+" if features['hr_delta_baseline'] > 0 else ""
            factors.append((
                abs(features['hr_delta_baseline']) * 0.8,
                f"Heart rate {sign}{features['hr_delta_baseline']:.0f} bpm from baseline ({baseline.get('heart_rate', 75)})"
            ))

        # Sort by clinical importance weight
        factors.sort(key=lambda x: x[0], reverse=True)
        ranked_factors = [item[1] for item in factors[:4]]

        if not ranked_factors:
            ranked_factors = ["Vitals steady with normal baseline physiological variance"]

        return {
            'risk_score': risk_score,
            'risk_level': str(pred_label),
            'horizon_hours': horizon_hours,
            'top_contributing_factors': ranked_factors,
            'confidence': confidence,
            'source': 'ml',
            'safety_notice': 'Experimental — synthetic data only. Research model; not clinical validation.',
        }

    except Exception as e:
        print(f"[TrendInference] ML execution error: {e}, falling back to rule engine")
        return rule_trend_fallback(normalized_readings, baseline, patient_context, horizon_hours)
