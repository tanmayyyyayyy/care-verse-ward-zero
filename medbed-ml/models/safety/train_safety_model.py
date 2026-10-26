"""
models/safety/train_safety_model.py
─────────────────────────────────────────────────────────────────────────────
Model 3: Weight & Pressure Safety Prediction
Algorithms:
  A. Random Forest Regressor  → fall_risk_probability (continuous 0–1)
  B. Random Forest Classifier → imbalance_detected (binary)
  C. Gradient Boosting        → safety_alert (3-class: Safe/Warning/Critical)

Why Random Forest for sensor data?
  ✓ Robust to sensor noise and outliers
  ✓ Handles correlated pressure sensor readings naturally
  ✓ Fast inference for real-time bed monitoring

Run:
    python models/safety/train_safety_model.py

Outputs:
    models/safety/fall_risk_model.pkl
    models/safety/imbalance_model.pkl
    models/safety/alert_model.pkl
    models/safety/scaler.pkl
    models/safety/safety_config.json
"""

import json
import joblib
import numpy as np
import pandas as pd
from pathlib import Path

from sklearn.ensemble import (
    RandomForestRegressor, RandomForestClassifier,
    GradientBoostingClassifier
)
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import (
    classification_report, accuracy_score,
    mean_absolute_error, roc_auc_score, r2_score
)
from sklearn.calibration import CalibratedClassifierCV

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT      = Path(__file__).parent.parent.parent
DATA_PATH = ROOT / 'data' / 'safety_dataset.csv'
MODEL_DIR = Path(__file__).parent
MODEL_DIR.mkdir(parents=True, exist_ok=True)

ALERT_LABELS    = {0: 'Safe', 1: 'Warning', 2: 'Critical'}
IMBALANCE_LABELS= {0: 'Balanced', 1: 'Imbalanced'}


# ══════════════════════════════════════════════════════════════════════════════
# Feature engineering
# ══════════════════════════════════════════════════════════════════════════════

def engineer_safety_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    # Total pressure (should ≈ weight_kg)
    df['total_pressure'] = (df['sensor_head'] + df['sensor_torso'] +
                            df['sensor_leg_left'] + df['sensor_leg_right'] +
                            df['sensor_foot'])

    # Weight-pressure discrepancy (high = concerning)
    df['pressure_discrepancy'] = np.abs(df['total_pressure'] - df['weight_kg'])

    # Left-right pressure symmetry ratio
    leg_sum = (df['sensor_leg_left'] + df['sensor_leg_right']).clip(lower=0.1)
    df['lr_symmetry'] = np.abs(df['sensor_leg_left'] - df['sensor_leg_right']) / leg_sum

    # Total acceleration magnitude
    df['accel_magnitude'] = np.sqrt(
        df['accel_x']**2 + df['accel_y']**2 + df['accel_z']**2
    )

    # Gyroscope magnitude
    df['gyro_magnitude'] = np.sqrt(df['gyro_roll']**2 + df['gyro_pitch']**2)

    # Rail safety score (0=both unlocked, 1=one, 2=both locked)
    df['rails_locked'] = df['rail_left_locked'] + df['rail_right_locked']

    # Movement intensity (movement_30s normalized by time)
    df['movement_rate'] = df['movement_30s'] / 30.0

    # BMI proxy (weight / age as frailty)
    df['frailty_index'] = df['weight_kg'] / df['age'].clip(lower=1)

    # Sensor head ratio — high head fraction may indicate patient sitting up
    df['head_ratio'] = df['sensor_head'] / df['total_pressure'].clip(lower=0.1)

    # Torso drop — if torso pressure decreases significantly → patient may be shifting
    df['torso_ratio'] = df['sensor_torso'] / df['total_pressure'].clip(lower=0.1)

    return df

ENGINEERED = [
    'total_pressure', 'pressure_discrepancy', 'lr_symmetry',
    'accel_magnitude', 'gyro_magnitude', 'rails_locked',
    'movement_rate', 'frailty_index', 'head_ratio', 'torso_ratio',
]

BASE_FEATURES = [
    'weight_kg', 'age', 'is_sedated',
    'sensor_head', 'sensor_torso', 'sensor_leg_left',
    'sensor_leg_right', 'sensor_foot',
    'accel_x', 'accel_y', 'accel_z',
    'gyro_roll', 'gyro_pitch',
    'rail_left_locked', 'rail_right_locked',
    'bed_angle', 'movement_30s',
]

ALL_FEATURES = BASE_FEATURES + ENGINEERED


# ══════════════════════════════════════════════════════════════════════════════
# Training
# ══════════════════════════════════════════════════════════════════════════════

def train():
    print("=" * 65)
    print("  MedBed OS — Model 3: Weight & Pressure Safety")
    print("=" * 65)

    # ── Load & engineer ───────────────────────────────────────────────────────
    print("\n📂  Loading safety dataset…")
    df = pd.read_csv(DATA_PATH)
    df = engineer_safety_features(df)
    print(f"    {len(df)} rows · {len(df.columns)} columns")
    print(f"    safety_alert dist.: {df['safety_alert'].value_counts().to_dict()}")
    print(f"    imbalance rate: {df['imbalance_detected'].mean():.1%}")

    X = df[ALL_FEATURES].values
    y_prob     = df['fall_risk_prob'].values
    y_imbalance= df['imbalance_detected'].values
    y_alert    = df['safety_alert'].values

    # ── Split ─────────────────────────────────────────────────────────────────
    X_tr, X_te, yp_tr, yp_te, yi_tr, yi_te, ya_tr, ya_te = train_test_split(
        X, y_prob, y_imbalance, y_alert,
        test_size=0.20, random_state=42, stratify=y_alert
    )

    # ── Scale ─────────────────────────────────────────────────────────────────
    scaler   = StandardScaler()
    X_tr_s   = scaler.fit_transform(X_tr)
    X_te_s   = scaler.transform(X_te)

    # ════════════════════════════════════════════════════════════════════════
    # Sub-model A: Fall Risk Probability (RF Regressor)
    # ════════════════════════════════════════════════════════════════════════
    print("\n🎯  Training Fall Risk Probability model (RandomForestRegressor)…")
    fall_model = RandomForestRegressor(
        n_estimators     = 300,
        max_depth        = 14,
        min_samples_leaf = 3,
        random_state     = 42,
        n_jobs           = -1,
    )
    fall_model.fit(X_tr_s, yp_tr)
    yp_pred = fall_model.predict(X_te_s).clip(0, 1)

    mae_fall = mean_absolute_error(yp_te, yp_pred)
    r2_fall  = r2_score(yp_te, yp_pred)
    # Custom metric: exact bin accuracy (Low/Med/High)
    pred_bin = np.where(yp_pred > 0.65, 2, np.where(yp_pred > 0.35, 1, 0))
    true_bin = np.where(yp_te   > 0.65, 2, np.where(yp_te   > 0.35, 1, 0))
    bin_acc  = accuracy_score(true_bin, pred_bin)

    print(f"\n📊  Fall Risk Regressor Results:")
    print(f"    MAE            : {mae_fall:.4f}")
    print(f"    R² Score       : {r2_fall:.4f}")
    print(f"    Bin Accuracy   : {bin_acc:.4f}  (Low/Med/High)")

    # Feature importance
    importance = sorted(zip(ALL_FEATURES, fall_model.feature_importances_),
                        key=lambda x: -x[1])
    print(f"\n    Top 10 features:")
    for feat, imp in importance[:10]:
        bar = '█' * int(imp * 80)
        print(f"    {feat:<28} {imp:.4f}  {bar}")

    # ════════════════════════════════════════════════════════════════════════
    # Sub-model B: Imbalance Detection (RF Classifier with calibration)
    # ════════════════════════════════════════════════════════════════════════
    print("\n⚖️   Training Imbalance Detection model (RandomForest + Calibration)…")
    imb_base = RandomForestClassifier(
        n_estimators = 200,
        max_depth    = 12,
        class_weight = 'balanced',
        random_state = 42,
        n_jobs       = -1,
    )
    # Calibrate for better probability estimates
    imbalance_model = CalibratedClassifierCV(imb_base, cv=5, method='sigmoid')
    imbalance_model.fit(X_tr_s, yi_tr)

    yi_pred  = imbalance_model.predict(X_te_s)
    yi_proba = imbalance_model.predict_proba(X_te_s)[:, 1]

    print(f"\n📊  Imbalance Detection Results:")
    print(f"    Accuracy: {accuracy_score(yi_te, yi_pred):.4f}")
    print(classification_report(yi_te, yi_pred,
                                target_names=['Balanced','Imbalanced'],
                                digits=4))
    try:
        auc = roc_auc_score(yi_te, yi_proba)
        print(f"    ROC AUC : {auc:.4f}")
    except Exception:
        pass

    # Cross-validation
    cv_scores = cross_val_score(imb_base, X_tr_s, yi_tr, cv=5, scoring='f1')
    print(f"    5-Fold CV F1: {cv_scores.mean():.4f} ± {cv_scores.std():.4f}")

    # ════════════════════════════════════════════════════════════════════════
    # Sub-model C: Safety Alert Class (Gradient Boosting)
    # ════════════════════════════════════════════════════════════════════════
    print("\n🚨  Training Safety Alert model (GradientBoostingClassifier)…")
    alert_model = GradientBoostingClassifier(
        n_estimators  = 300,
        learning_rate = 0.07,
        max_depth     = 5,
        subsample     = 0.85,
        random_state  = 42,
    )
    alert_model.fit(X_tr_s, ya_tr)
    ya_pred  = alert_model.predict(X_te_s)
    ya_proba = alert_model.predict_proba(X_te_s)

    print(f"\n📊  Safety Alert Results:")
    print(f"    Accuracy: {accuracy_score(ya_te, ya_pred):.4f}")
    print(classification_report(ya_te, ya_pred,
                                target_names=['Safe','Warning','Critical'],
                                digits=4))
    try:
        auc = roc_auc_score(ya_te, ya_proba, multi_class='ovr')
        print(f"    ROC AUC (OvR): {auc:.4f}")
    except Exception:
        pass

    # ── Save all artefacts ────────────────────────────────────────────────────
    joblib.dump(fall_model,      MODEL_DIR / 'fall_risk_model.pkl')
    joblib.dump(imbalance_model, MODEL_DIR / 'imbalance_model.pkl')
    joblib.dump(alert_model,     MODEL_DIR / 'alert_model.pkl')
    joblib.dump(scaler,          MODEL_DIR / 'scaler.pkl')

    config = {
        'feature_cols':    ALL_FEATURES,
        'base_features':   BASE_FEATURES,
        'engineered':      ENGINEERED,
        'alert_labels':    ALERT_LABELS,
        'imbalance_labels':IMBALANCE_LABELS,
        'fall_risk_mae':   float(mae_fall),
        'imbalance_acc':   float(accuracy_score(yi_te, yi_pred)),
        'alert_acc':       float(accuracy_score(ya_te, ya_pred)),
    }
    with open(MODEL_DIR / 'safety_config.json', 'w') as f:
        json.dump(config, f, indent=2)

    print(f"\n💾  Saved to {MODEL_DIR}/")
    print("    fall_risk_model.pkl · imbalance_model.pkl · alert_model.pkl · scaler.pkl\n")


# ══════════════════════════════════════════════════════════════════════════════
# Inference wrapper
# ══════════════════════════════════════════════════════════════════════════════

class SafetyPredictor:
    """Real-time safety prediction from bed sensor readings."""

    def __init__(self, model_dir: Path = MODEL_DIR):
        self.fall_model      = joblib.load(model_dir / 'fall_risk_model.pkl')
        self.imbalance_model = joblib.load(model_dir / 'imbalance_model.pkl')
        self.alert_model     = joblib.load(model_dir / 'alert_model.pkl')
        self.scaler          = joblib.load(model_dir / 'scaler.pkl')
        with open(model_dir / 'safety_config.json') as f:
            self.cfg = json.load(f)

    def predict(self, raw: dict) -> dict:
        df  = pd.DataFrame([raw])
        df  = engineer_safety_features(df)
        X   = df[self.cfg['feature_cols']].values
        Xs  = self.scaler.transform(X)

        fall_prob    = float(self.fall_model.predict(Xs)[0].clip(0, 1))
        imb_prob     = float(self.imbalance_model.predict_proba(Xs)[0][1])
        imb_flag     = int(imb_prob > 0.5)
        alert_proba  = self.alert_model.predict_proba(Xs)[0]
        alert_cls    = int(alert_proba.argmax())

        return {
            'fall_risk_prob':       round(fall_prob, 4),
            'fall_risk_label':      'High' if fall_prob > 0.65 else 'Medium' if fall_prob > 0.35 else 'Low',
            'imbalance_prob':       round(imb_prob, 4),
            'imbalance_detected':   imb_flag,
            'imbalance_label':      self.cfg['imbalance_labels'][str(imb_flag)],
            'safety_alert':         alert_cls,
            'safety_alert_label':   self.cfg['alert_labels'][str(alert_cls)],
            'alert_probabilities': {
                'Safe':     round(float(alert_proba[0]), 4),
                'Warning':  round(float(alert_proba[1]), 4),
                'Critical': round(float(alert_proba[2]), 4),
            },
        }


if __name__ == '__main__':
    train()
