"""
models/transfer/train_transfer_model.py
─────────────────────────────────────────────────────────────────────────────
Model 1: Patient Transfer Prediction
Algorithm: Gradient Boosting Classifier (risk_level) +
           Random Forest Regressor (estimated_minutes) +
           Random Forest Classifier (staff_count)

Why these algorithms?
  ✓ Gradient Boosting handles class imbalance well
  ✓ Robust to outliers in clinical vitals
  ✓ No normalisation needed for tree-based models
  ✓ Fast inference (<10ms) for real-time use

Run:
    python models/transfer/train_transfer_model.py

Outputs:
    models/transfer/risk_model.pkl
    models/transfer/staff_model.pkl
    models/transfer/time_model.pkl
    models/transfer/preprocessor.pkl
    models/transfer/feature_names.json
"""

import json
import joblib
import numpy as np
import pandas as pd
from pathlib import Path

from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier, RandomForestRegressor
from sklearn.model_selection import train_test_split, StratifiedKFold, cross_val_score
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import (
    classification_report, confusion_matrix,
    mean_absolute_error, r2_score, accuracy_score
)
from sklearn.pipeline import Pipeline
from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import OrdinalEncoder
from imblearn.over_sampling import SMOTE

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT       = Path(__file__).parent.parent.parent
DATA_PATH  = ROOT / 'data' / 'transfer_dataset.csv'
MODEL_DIR  = Path(__file__).parent
MODEL_DIR.mkdir(parents=True, exist_ok=True)

# ── Feature definitions ────────────────────────────────────────────────────────
NUMERIC_FEATURES = [
    'age', 'weight_kg', 'heart_rate', 'spo2',
    'bp_systolic', 'bp_diastolic', 'transfer_distance',
    'time_of_day', 'equipment_count',
]
CATEGORICAL_FEATURES = [
    'condition', 'department_from', 'department_to', 'is_post_surgery',
]
ALL_FEATURES   = NUMERIC_FEATURES + CATEGORICAL_FEATURES
RISK_TARGET    = 'risk_level'
STAFF_TARGET   = 'staff_count'
TIME_TARGET    = 'estimated_minutes'

RISK_LABELS  = {0: 'Low', 1: 'Medium', 2: 'High'}
STAFF_LABELS = {1: '1 Staff', 2: '2 Staff', 3: '3 Staff', 4: '4 Staff'}


# ══════════════════════════════════════════════════════════════════════════════
# Feature Engineering
# ══════════════════════════════════════════════════════════════════════════════

def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    # Pulse pressure (cardiovascular stress indicator)
    df['pulse_pressure']   = df['bp_systolic'] - df['bp_diastolic']
    # Mean arterial pressure
    df['map']              = df['bp_diastolic'] + df['pulse_pressure'] / 3
    # Shock index (HR / systolic BP) — >0.9 is concerning
    df['shock_index']      = df['heart_rate'] / df['bp_systolic'].clip(lower=1)
    # ICU-to-ICU flag (highest complexity)
    df['icu_to_icu']       = ((df['department_from'] == 1) & (df['department_to'] == 1)).astype(int)
    # Night transfer risk (02:00–06:00 reduced staffing)
    df['is_night']         = ((df['time_of_day'] >= 2) & (df['time_of_day'] <= 6)).astype(int)
    # Frailty index proxy
    df['age_weight_ratio'] = df['age'] / df['weight_kg'].clip(lower=1)
    return df

ENGINEERED = ['pulse_pressure', 'map', 'shock_index', 'icu_to_icu',
              'is_night', 'age_weight_ratio']


# ══════════════════════════════════════════════════════════════════════════════
# Build preprocessor pipeline
# ══════════════════════════════════════════════════════════════════════════════

def build_preprocessor():
    numeric_cols = NUMERIC_FEATURES + ENGINEERED
    cat_cols     = CATEGORICAL_FEATURES

    return ColumnTransformer(transformers=[
        ('num', StandardScaler(), numeric_cols),
        ('cat', OrdinalEncoder(handle_unknown='use_encoded_value',
                               unknown_value=-1), cat_cols),
    ], remainder='drop')


# ══════════════════════════════════════════════════════════════════════════════
# Training
# ══════════════════════════════════════════════════════════════════════════════

def train():
    print("=" * 65)
    print("  MedBed OS — Model 1: Patient Transfer Prediction")
    print("=" * 65)

    # ── Load & engineer features ──────────────────────────────────────────────
    print("\n📂  Loading dataset…")
    df = pd.read_csv(DATA_PATH)
    df = engineer_features(df)
    print(f"    {len(df)} rows · {len(df.columns)} columns")

    feature_cols = NUMERIC_FEATURES + ENGINEERED + CATEGORICAL_FEATURES
    X = df[feature_cols]
    y_risk  = df[RISK_TARGET]
    y_staff = df[STAFF_TARGET]
    y_time  = df[TIME_TARGET]

    # ── Train/test split ──────────────────────────────────────────────────────
    X_train, X_test, yr_train, yr_test, ys_train, ys_test, yt_train, yt_test = \
        train_test_split(X, y_risk, y_staff, y_time,
                         test_size=0.20, random_state=42, stratify=y_risk)

    print(f"    Train: {len(X_train)} · Test: {len(X_test)}")

    # ── Preprocessor ─────────────────────────────────────────────────────────
    preprocessor = build_preprocessor()
    X_train_t = preprocessor.fit_transform(X_train)
    X_test_t  = preprocessor.transform(X_test)

    # ── SMOTE for class imbalance on risk_level ───────────────────────────────
    smote = SMOTE(random_state=42)
    X_train_bal, yr_train_bal = smote.fit_resample(X_train_t, yr_train)
    print(f"    After SMOTE: {X_train_bal.shape[0]} rows")

    # ════════════════════════════════════════════════════════════════════════
    # Sub-model A: Risk Level (Gradient Boosting Classifier)
    # ════════════════════════════════════════════════════════════════════════
    print("\n🌲  Training Risk Level model (GradientBoostingClassifier)…")
    risk_model = GradientBoostingClassifier(
        n_estimators   = 250,
        learning_rate  = 0.08,
        max_depth      = 5,
        min_samples_split = 4,
        subsample      = 0.85,
        random_state   = 42,
    )
    risk_model.fit(X_train_bal, yr_train_bal)

    yr_pred = risk_model.predict(X_test_t)
    yr_prob = risk_model.predict_proba(X_test_t)

    print(f"\n📊  Risk Level Results:")
    print(f"    Accuracy : {accuracy_score(yr_test, yr_pred):.4f}")
    print(f"\n    Classification Report:")
    print(classification_report(yr_test, yr_pred,
                                target_names=['Low','Medium','High'],
                                digits=4))

    # Cross-validation
    cv_scores = cross_val_score(risk_model, X_train_bal, yr_train_bal,
                                cv=StratifiedKFold(5), scoring='f1_weighted')
    print(f"    5-Fold CV F1 (weighted): {cv_scores.mean():.4f} ± {cv_scores.std():.4f}")

    # Feature importance
    feat_names = NUMERIC_FEATURES + ENGINEERED + CATEGORICAL_FEATURES
    importance = sorted(zip(feat_names, risk_model.feature_importances_),
                        key=lambda x: -x[1])
    print(f"\n    Top 8 features:")
    for feat, imp in importance[:8]:
        bar = '█' * int(imp * 60)
        print(f"    {feat:<25} {imp:.4f}  {bar}")

    # ════════════════════════════════════════════════════════════════════════
    # Sub-model B: Staff Count (Random Forest Classifier)
    # ════════════════════════════════════════════════════════════════════════
    print("\n👥  Training Staff Count model (RandomForestClassifier)…")
    staff_model = RandomForestClassifier(
        n_estimators = 200,
        max_depth    = 10,
        class_weight = 'balanced',
        random_state = 42,
        n_jobs       = -1,
    )
    staff_model.fit(X_train_t, ys_train)
    ys_pred = staff_model.predict(X_test_t)

    print(f"\n📊  Staff Count Results:")
    print(f"    Accuracy : {accuracy_score(ys_test, ys_pred):.4f}")
    print(classification_report(ys_test, ys_pred,
                                target_names=['1 Staff','2 Staff','3 Staff','4 Staff'],
                                digits=4, zero_division=0))

    # ════════════════════════════════════════════════════════════════════════
    # Sub-model C: Estimated Time (Random Forest Regressor)
    # ════════════════════════════════════════════════════════════════════════
    print("\n⏱️   Training Transfer Time model (RandomForestRegressor)…")
    time_model = RandomForestRegressor(
        n_estimators = 200,
        max_depth    = 12,
        random_state = 42,
        n_jobs       = -1,
    )
    time_model.fit(X_train_t, yt_train)
    yt_pred = time_model.predict(X_test_t)

    mae = mean_absolute_error(yt_test, yt_pred)
    r2  = r2_score(yt_test, yt_pred)
    within_2min = np.mean(np.abs(yt_test - yt_pred) <= 2) * 100

    print(f"\n📊  Time Regression Results:")
    print(f"    MAE             : {mae:.2f} minutes")
    print(f"    R² Score        : {r2:.4f}")
    print(f"    Within ±2 min   : {within_2min:.1f}%")

    # ════════════════════════════════════════════════════════════════════════
    # Save artefacts
    # ════════════════════════════════════════════════════════════════════════
    joblib.dump(risk_model,   MODEL_DIR / 'risk_model.pkl')
    joblib.dump(staff_model,  MODEL_DIR / 'staff_model.pkl')
    joblib.dump(time_model,   MODEL_DIR / 'time_model.pkl')
    joblib.dump(preprocessor, MODEL_DIR / 'preprocessor.pkl')

    meta = {
        'feature_cols':     feature_cols,
        'numeric_features': NUMERIC_FEATURES + ENGINEERED,
        'cat_features':     CATEGORICAL_FEATURES,
        'risk_labels':      RISK_LABELS,
        'staff_labels':     STAFF_LABELS,
    }
    with open(MODEL_DIR / 'feature_names.json', 'w') as f:
        json.dump(meta, f, indent=2)

    print(f"\n💾  Saved to {MODEL_DIR}/")
    print("    risk_model.pkl · staff_model.pkl · time_model.pkl · preprocessor.pkl\n")


# ══════════════════════════════════════════════════════════════════════════════
# Inference helper (used by API)
# ══════════════════════════════════════════════════════════════════════════════

class TransferPredictor:
    """Production inference wrapper. Loads once, predicts many times."""

    def __init__(self, model_dir: Path = MODEL_DIR):
        self.preprocessor = joblib.load(model_dir / 'preprocessor.pkl')
        self.risk_model   = joblib.load(model_dir / 'risk_model.pkl')
        self.staff_model  = joblib.load(model_dir / 'staff_model.pkl')
        self.time_model   = joblib.load(model_dir / 'time_model.pkl')
        with open(model_dir / 'feature_names.json') as f:
            self.meta = json.load(f)

    def predict(self, raw: dict) -> dict:
        """
        raw: dict matching ALL_FEATURES keys
        Returns: { risk_level, risk_label, risk_probabilities,
                   staff_count, estimated_minutes }
        """
        df  = pd.DataFrame([raw])
        df  = engineer_features(df)
        X   = df[self.meta['feature_cols']]
        Xt  = self.preprocessor.transform(X)

        risk_idx   = int(self.risk_model.predict(Xt)[0])
        risk_proba = self.risk_model.predict_proba(Xt)[0].tolist()
        staff      = int(self.staff_model.predict(Xt)[0])
        minutes    = float(self.time_model.predict(Xt)[0])

        return {
            'risk_level':        risk_idx,
            'risk_label':        RISK_LABELS[risk_idx],
            'risk_probabilities': {
                'Low':    round(risk_proba[0], 4),
                'Medium': round(risk_proba[1], 4),
                'High':   round(risk_proba[2], 4),
            },
            'staff_count':       staff,
            'estimated_minutes': round(minutes, 1),
        }


if __name__ == '__main__':
    train()
