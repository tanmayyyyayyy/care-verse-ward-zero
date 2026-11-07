# ai-service/train_trend.py
"""
Train 24-48h Patient Deterioration Risk Trend Model.
Generates forward-in-time synthetic multi-parameter patient vitals time series,
extracts clinical trend features (slopes, rolling stats, variability, threshold duration,
NEWS2 rolling scores, and baseline deviations), performs a strict time-based split,
trains a Gradient Boosting Classifier, and outputs reproducible metrics.

Usage:
    python train_trend.py

Outputs:
    trend_model.pkl       - Trained GradientBoostingClassifier
    trend_features.json   - Ordered list of feature names
    trend_metrics.json    - Evaluation metrics and split summary
"""

import os
import json
import numpy as np
import pandas as pd
import joblib
from scipy.stats import linregress
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.metrics import classification_report, accuracy_score, f1_score, roc_auc_score
from datetime import datetime

RANDOM_SEED = 42
np.random.seed(RANDOM_SEED)

MODEL_PATH = os.path.join(os.path.dirname(__file__), 'trend_model.pkl')
FEATURES_PATH = os.path.join(os.path.dirname(__file__), 'trend_features.json')
METRICS_PATH = os.path.join(os.path.dirname(__file__), 'trend_metrics.json')


def compute_news2(hr, spo2, bp_sys, rr, temp):
    """
    Compute National Early Warning Score 2 (NEWS2) sub-score for vital signs.
    """
    score = 0
    # Respiration Rate
    if rr <= 8 or rr >= 25:
        score += 3
    elif 21 <= rr <= 24:
        score += 2
    elif 9 <= rr <= 11:
        score += 1

    # SpO2
    if spo2 <= 91:
        score += 3
    elif 92 <= spo2 <= 93:
        score += 2
    elif 94 <= spo2 <= 95:
        score += 1

    # Systolic BP
    if bp_sys <= 90 or bp_sys >= 220:
        score += 3
    elif 91 <= bp_sys <= 100:
        score += 2
    elif 101 <= bp_sys <= 110:
        score += 1

    # Heart Rate
    if hr <= 40 or hr >= 131:
        score += 3
    elif 111 <= hr <= 130:
        score += 2
    elif (41 <= hr <= 50) or (91 <= hr <= 110):
        score += 1

    # Temperature
    if temp <= 35.0:
        score += 3
    elif temp >= 39.1:
        score += 2
    elif (35.1 <= temp <= 36.0) or (38.1 <= temp <= 39.0):
        score += 1

    return score


def extract_window_features(readings, baseline, patient_context):
    """
    Extract clinical trend features over a window of chronological readings.
    readings: list of dicts with keys (t_hours, heart_rate, spo2, bp_systolic, bp_diastolic, respiratory_rate, temperature)
    baseline: dict with baseline vitals
    patient_context: dict with age, condition, is_post_surgery
    """
    n = len(readings)
    if n < 5:
        return None

    times = np.array([r['t_hours'] for r in readings], dtype=float)
    dt = times - times[0]  # hours from window start
    span_hours = max(1.0, times[-1] - times[0])

    hrs = np.array([r['heart_rate'] for r in readings], dtype=float)
    spo2s = np.array([r['spo2'] for r in readings], dtype=float)
    bps = np.array([r['bp_systolic'] for r in readings], dtype=float)
    rrs = np.array([r['respiratory_rate'] for r in readings], dtype=float)
    temps = np.array([r.get('temperature', 37.0) for r in readings], dtype=float)

    # 1. Slopes (per hour) using linear regression
    hr_slope = linregress(dt, hrs).slope if len(set(dt)) > 1 else 0.0
    spo2_slope = linregress(dt, spo2s).slope if len(set(dt)) > 1 else 0.0
    bp_sys_slope = linregress(dt, bps).slope if len(set(dt)) > 1 else 0.0
    rr_slope = linregress(dt, rrs).slope if len(set(dt)) > 1 else 0.0
    temp_slope = linregress(dt, temps).slope if len(set(dt)) > 1 else 0.0

    # 2. Rolling stats over the window
    mean_hr = float(np.mean(hrs))
    std_hr = float(np.std(hrs))
    mean_spo2 = float(np.mean(spo2s))
    std_spo2 = float(np.std(spo2s))
    mean_bp = float(np.mean(bps))
    std_bp = float(np.std(bps))
    mean_rr = float(np.mean(rrs))
    std_rr = float(np.std(rrs))

    # 3. Variability / Instability
    cv_hr = std_hr / max(mean_hr, 1.0)
    cv_spo2 = std_spo2 / max(mean_spo2, 1.0)

    # 4. Threshold durations (fraction of window or hours)
    # Estimate time interval per step
    step_hrs = span_hours / max(1, n - 1)
    hours_spo2_below_92 = float(np.sum(spo2s < 92) * step_hrs)
    hours_sys_below_90 = float(np.sum(bps < 90) * step_hrs)
    hours_hr_above_100 = float(np.sum(hrs > 100) * step_hrs)
    hours_rr_above_24 = float(np.sum(rrs > 24) * step_hrs)

    # 5. NEWS2 scores
    news_scores = [compute_news2(h, s, b, r, t) for h, s, b, r, t in zip(hrs, spo2s, bps, rrs, temps)]
    news_latest = news_scores[-1]
    news_mean = float(np.mean(news_scores))
    news_max = int(np.max(news_scores))
    news_slope = linregress(dt, news_scores).slope if len(set(dt)) > 1 else 0.0

    # 6. Deviation from patient baseline
    base_hr = float(baseline.get('heart_rate', 75.0))
    base_spo2 = float(baseline.get('spo2', 98.0))
    base_bp = float(baseline.get('bp_systolic', 120.0))
    base_rr = float(baseline.get('respiratory_rate', 16.0))

    hr_delta_baseline = float(hrs[-1] - base_hr)
    spo2_delta_baseline = float(spo2s[-1] - base_spo2)
    bp_delta_baseline = float(bps[-1] - base_bp)
    rr_delta_baseline = float(rrs[-1] - base_rr)

    # 7. Patient context
    age = float(patient_context.get('age', 60))
    is_post_surgery = 1.0 if patient_context.get('is_post_surgery') else 0.0
    cond = patient_context.get('condition', 'general')
    cond_risk = 1.0 if cond in ('cardiac', 'respiratory', 'icu') else 0.0

    features = {
        'span_hours': float(span_hours),
        'hr_slope': float(hr_slope),
        'spo2_slope': float(spo2_slope),
        'bp_sys_slope': float(bp_sys_slope),
        'rr_slope': float(rr_slope),
        'temp_slope': float(temp_slope),
        'mean_hr': mean_hr,
        'std_hr': std_hr,
        'mean_spo2': mean_spo2,
        'std_spo2': std_spo2,
        'mean_bp': mean_bp,
        'std_bp': std_bp,
        'mean_rr': mean_rr,
        'std_rr': std_rr,
        'cv_hr': float(cv_hr),
        'cv_spo2': float(cv_spo2),
        'hours_spo2_below_92': hours_spo2_below_92,
        'hours_sys_below_90': hours_sys_below_90,
        'hours_hr_above_100': hours_hr_above_100,
        'hours_rr_above_24': hours_rr_above_24,
        'news_latest': float(news_latest),
        'news_mean': news_mean,
        'news_max': float(news_max),
        'news_slope': float(news_slope),
        'hr_delta_baseline': hr_delta_baseline,
        'spo2_delta_baseline': spo2_delta_baseline,
        'bp_delta_baseline': bp_delta_baseline,
        'rr_delta_baseline': rr_delta_baseline,
        'age': age,
        'is_post_surgery': is_post_surgery,
        'condition_risk': cond_risk,
    }
    return features


def generate_patient_time_series(patient_id, pattern_type, total_hours=72, step_hours=1.0):
    """
    Generate forward-in-time synthetic trajectory for one patient.
    Patterns:
      - 'stable': normal circadian variation, minor noise
      - 'gradual_respiratory_decline': slow decline in SpO2, compensatory RR and HR rise
      - 'hemodynamic_instability': sepsis/decompensation, BP drop, tachycardia, fever
      - 'transient_fluctuation': temporary blip around hour 24, recovery by hour 36
    """
    times = np.arange(0, total_hours + 0.1, step_hours)
    n_steps = len(times)

    # Base characteristics
    base_hr = np.random.normal(72, 6)
    base_spo2 = np.random.normal(98, 1)
    base_bp = np.random.normal(120, 8)
    base_rr = np.random.normal(15, 2)
    base_temp = 36.8

    baseline = {
        'heart_rate': float(base_hr),
        'spo2': float(base_spo2),
        'bp_systolic': float(base_bp),
        'respiratory_rate': float(base_rr),
    }

    age = int(np.random.randint(45, 85))
    is_post_surg = bool(np.random.choice([False, True], p=[0.7, 0.3]))
    conditions = ['general', 'cardiac', 'respiratory', 'orthopaedic', 'icu']
    condition = np.random.choice(conditions)
    context = {'age': age, 'is_post_surgery': is_post_surg, 'condition': condition}

    readings = []
    for t in times:
        # Circadian rhythm (24h period)
        circ = np.sin(2 * np.pi * t / 24.0)

        # Noise
        noise_hr = np.random.normal(0, 2.0)
        noise_spo2 = np.random.normal(0, 0.5)
        noise_bp = np.random.normal(0, 3.0)
        noise_rr = np.random.normal(0, 1.0)
        noise_temp = np.random.normal(0, 0.1)

        cur_hr = base_hr + circ * 3.0 + noise_hr
        cur_spo2 = base_spo2 + noise_spo2
        cur_bp = base_bp + circ * 4.0 + noise_bp
        cur_rr = base_rr + noise_rr
        cur_temp = base_temp + circ * 0.2 + noise_temp

        if pattern_type == 'gradual_respiratory_decline':
            # Starts slowly around hour 12, accelerates after hour 24
            if t > 12:
                elapsed = t - 12
                cur_spo2 -= 0.15 * elapsed + 0.003 * (elapsed ** 2)
                cur_rr += 0.2 * elapsed
                cur_hr += 0.25 * elapsed

        elif pattern_type == 'hemodynamic_instability':
            # Starts around hour 18, BP declines, HR spikes, fever
            if t > 18:
                elapsed = t - 18
                cur_bp -= 0.6 * elapsed
                cur_hr += 0.8 * elapsed
                cur_temp += 0.04 * elapsed
                cur_rr += 0.2 * elapsed

        elif pattern_type == 'transient_fluctuation':
            # Blip between hour 20 and 32, then settles back
            if 20 <= t <= 32:
                dist = 6 - abs(t - 26)
                cur_hr += dist * 2.5
                cur_spo2 -= dist * 0.5
                cur_rr += dist * 1.0

        # Physiological bounds
        cur_hr = float(np.clip(cur_hr, 35, 190))
        cur_spo2 = float(np.clip(cur_spo2, 65, 100))
        cur_bp = float(np.clip(cur_bp, 50, 230))
        cur_rr = float(np.clip(cur_rr, 8, 48))
        cur_temp = float(np.clip(cur_temp, 34.0, 41.5))

        readings.append({
            't_hours': float(t),
            'heart_rate': cur_hr,
            'spo2': cur_spo2,
            'bp_systolic': cur_bp,
            'bp_diastolic': cur_bp * 0.62,
            'respiratory_rate': cur_rr,
            'temperature': cur_temp,
        })

    return readings, baseline, context


def build_longitudinal_dataset():
    """
    Generate longitudinal cohort with forward-in-time observation windows.
    We simulate 400 patients over 72 hours each.
    For each patient, we sample observation windows of length 24h-48h.
    The target label is the patient condition in the FUTURE (hours 48 to 72):
      - 'high': patient had severe deterioration in future 24h (SpO2 < 88, SBP < 85, or NEWS2 >= 7)
      - 'medium': patient had moderate deterioration in future 24h (SpO2 < 93, SBP < 100, or NEWS2 >= 5)
      - 'low': patient remained stable throughout future 24h
    
    Strict Time-Based Split:
    Patients are indexed chronologically. The first 70% of chronological patient simulations
    form the Train set; the remaining 30% form the Test set. No patient or overlapping
    window crosses between Train and Test sets (zero leakage).
    """
    patterns = ['stable', 'gradual_respiratory_decline', 'hemodynamic_instability', 'transient_fluctuation']
    p_weights = [0.45, 0.25, 0.20, 0.10]

    all_samples = []
    n_patients = 400

    for pid in range(n_patients):
        pattern = np.random.choice(patterns, p=p_weights)
        readings, baseline, context = generate_patient_time_series(pid, pattern, total_hours=72, step_hours=1.0)

        # Sample multiple realistic observation window lengths per patient
        window_configs = [
            (0.0, 6.0),
            (6.0, 12.0),
            (0.0, 12.0),
            (0.0, 24.0),
            (12.0, 36.0),
            (0.0, 48.0),
        ]

        for t_start, t_end in window_configs:
            obs_window = [r for r in readings if t_start <= r['t_hours'] <= t_end]
            fut_window = [r for r in readings if t_end < r['t_hours'] <= min(72.0, t_end + 24.0)]

            if len(obs_window) < 5 or not fut_window:
                continue

            feat = extract_window_features(obs_window, baseline, context)
            if feat is None:
                continue

            # Ground truth label based on future outcome in 24h horizon after t_end
            fut_news = [compute_news2(r['heart_rate'], r['spo2'], r['bp_systolic'], r['respiratory_rate'], r['temperature']) for r in fut_window]
            max_fut_news = max(fut_news) if fut_news else 0
            min_fut_spo2 = min([r['spo2'] for r in fut_window]) if fut_window else 100
            min_fut_bp = min([r['bp_systolic'] for r in fut_window]) if fut_window else 120

            if max_fut_news >= 7 or min_fut_spo2 < 88.0 or min_fut_bp < 85.0:
                label = 'high'
            elif max_fut_news >= 5 or min_fut_spo2 < 93.0 or min_fut_bp < 100.0:
                label = 'medium'
            else:
                label = 'low'

            feat['target'] = label
            feat['patient_id'] = pid
            feat['pattern'] = pattern
            all_samples.append(feat)

    df = pd.DataFrame(all_samples)
    return df


def train_trend_model():
    print("=" * 60)
    print("  Operation Ward Zero — 24-48h Trend Deterioration Model")
    print("=" * 60)

    print("Generating longitudinal synthetic cohort forward in time...")
    df = build_longitudinal_dataset()
    print(f"Total cohort samples: {len(df)}")
    print(f"Label distribution:\n{df['target'].value_counts()}")

    # Strict Time-Based / Chronological Cohort Split (No Leakage)
    split_patient_idx = int(df['patient_id'].max() * 0.70)
    train_df = df[df['patient_id'] <= split_patient_idx].copy()
    test_df = df[df['patient_id'] > split_patient_idx].copy()

    feature_cols = [c for c in df.columns if c not in ('target', 'patient_id', 'pattern')]
    print(f"\nFeatures ({len(feature_cols)}): {feature_cols}")

    X_train = train_df[feature_cols].values
    y_train = train_df['target'].values
    X_test = test_df[feature_cols].values
    y_test = test_df['target'].values

    print(f"Train set: {len(X_train)} samples (patients 0-{split_patient_idx})")
    print(f"Test set:  {len(X_test)} samples (patients {split_patient_idx + 1}-{df['patient_id'].max()})")

    # Train GradientBoostingClassifier
    clf = GradientBoostingClassifier(
        n_estimators=120,
        learning_rate=0.08,
        max_depth=4,
        random_state=RANDOM_SEED,
        subsample=0.85
    )
    clf.fit(X_train, y_train)

    y_pred = clf.predict(X_test)
    y_proba = clf.predict_proba(X_test)

    acc = float(accuracy_score(y_test, y_pred))
    f1_macro = float(f1_score(y_test, y_pred, average='macro'))
    f1_weighted = float(f1_score(y_test, y_pred, average='weighted'))

    # Multi-class ROC AUC
    try:
        roc_auc = float(roc_auc_score(y_test, y_proba, multi_class='ovr', average='macro'))
    except Exception:
        roc_auc = None

    rep = classification_report(y_test, y_pred, output_dict=True)

    print("\n" + "-" * 50)
    print("Evaluation Results (Strict Time-Based Test Set):")
    print(f"  Accuracy:    {acc:.4f}")
    print(f"  F1 (macro):  {f1_macro:.4f}")
    print(f"  F1 (weight): {f1_weighted:.4f}")
    if roc_auc:
        print(f"  ROC-AUC:     {roc_auc:.4f}")
    print("-" * 50)
    print("Classification Report:")
    print(classification_report(y_test, y_pred))

    # Feature importances
    importances = dict(zip(feature_cols, [float(v) for v in clf.feature_importances_]))
    sorted_importances = sorted(importances.items(), key=lambda x: x[1], reverse=True)
    print("Top 8 Features by Gini Importance:")
    for name, imp in sorted_importances[:8]:
        print(f"  - {name:22s}: {imp:.4f}")

    # Save artifacts
    joblib.dump(clf, MODEL_PATH)
    with open(FEATURES_PATH, 'w') as f:
        json.dump(feature_cols, f, indent=2)

    metrics_data = {
        'timestamp': datetime.utcnow().isoformat() + 'Z',
        'command': 'python train_trend.py',
        'random_seed': RANDOM_SEED,
        'model_type': 'GradientBoostingClassifier(n_estimators=120, max_depth=4, lr=0.08)',
        'data_cohort': {
            'total_patients': int(df['patient_id'].nunique()),
            'total_samples': len(df),
            'train_samples': len(train_df),
            'test_samples': len(test_df),
            'split_method': 'chronological_patient_cohort (70/30, zero leakage)',
        },
        'metrics': {
            'accuracy': acc,
            'f1_macro': f1_macro,
            'f1_weighted': f1_weighted,
            'roc_auc_macro_ovr': roc_auc,
            'per_class': {
                'low': rep['low'],
                'medium': rep['medium'],
                'high': rep['high'],
            }
        },
        'top_features': sorted_importances[:10],
    }

    with open(METRICS_PATH, 'w') as f:
        json.dump(metrics_data, f, indent=2)

    print(f"\nArtifacts saved successfully:")
    print(f"  Model:    {MODEL_PATH}")
    print(f"  Features: {FEATURES_PATH}")
    print(f"  Metrics:  {METRICS_PATH}")
    return metrics_data


if __name__ == '__main__':
    train_trend_model()
