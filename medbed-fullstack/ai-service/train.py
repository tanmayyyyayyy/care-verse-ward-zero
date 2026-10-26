# ai-service/train.py
# Trains a Random Forest classifier to predict patient transfer risk level.
# Generates synthetic healthcare data, trains, evaluates, and saves the model.
#
# Run: python train.py

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import LabelEncoder
from sklearn.metrics import classification_report, accuracy_score
import joblib
import os

RANDOM_SEED  = 42
MODEL_PATH   = 'risk_model.pkl'
ENCODER_PATH = 'label_encoder.pkl'
N_SAMPLES    = 5000


# ── 1. Synthetic data generation ─────────────────────────────────────────────

def generate_dataset(n: int) -> pd.DataFrame:
    """
    Create realistic synthetic patient vitals + metadata.
    Risk label is derived from domain rules so the model learns
    clinically meaningful patterns.
    """
    np.random.seed(RANDOM_SEED)

    heart_rate    = np.random.normal(85, 18, n).clip(40, 160).astype(int)
    spo2          = np.random.normal(96,  4, n).clip(70, 100).astype(int)
    bp_systolic   = np.random.normal(125, 22, n).clip(70, 200).astype(int)
    bp_diastolic  = (bp_systolic * 0.63 + np.random.normal(0, 5, n)).clip(40, 130).astype(int)
    age           = np.random.randint(18, 90, n)
    is_post_surgery = np.random.choice([0, 1], n, p=[0.6, 0.4])

    conditions = ['general', 'cardiac', 'hydrocephalus', 'icu', 'respiratory', 'orthopaedic']
    condition  = np.random.choice(conditions, n, p=[0.35, 0.25, 0.10, 0.15, 0.10, 0.05])

    # ── Rule-based labelling ─────────────────────────────────────────────────
    risk = []
    for i in range(n):
        score = 0
        # Vitals scoring
        if heart_rate[i]   > 115: score += 3
        elif heart_rate[i] > 100: score += 1
        if spo2[i]          <  90: score += 3
        elif spo2[i]        <  94: score += 2
        if bp_systolic[i]   > 160: score += 3
        elif bp_systolic[i] > 140: score += 1
        # Demographics
        if age[i]            >  70: score += 1
        if is_post_surgery[i] == 1: score += 1
        # Condition multiplier
        if condition[i] in ('icu', 'cardiac'):      score += 2
        elif condition[i] == 'hydrocephalus':       score += 1

        if   score >= 5: risk.append('high')
        elif score >= 2: risk.append('medium')
        else:            risk.append('low')

    return pd.DataFrame({
        'heart_rate':      heart_rate,
        'spo2':            spo2,
        'bp_systolic':     bp_systolic,
        'bp_diastolic':    bp_diastolic,
        'age':             age,
        'is_post_surgery': is_post_surgery,
        'condition':       condition,
        'risk':            risk,
    })


# ── 2. Feature engineering ────────────────────────────────────────────────────

CONDITION_MAP = {
    'general': 0, 'orthopaedic': 1, 'respiratory': 2,
    'hydrocephalus': 3, 'cardiac': 4, 'icu': 5,
}

def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df['condition_code'] = df['condition'].map(CONDITION_MAP).fillna(0).astype(int)
    df['pulse_pressure'] = df['bp_systolic'] - df['bp_diastolic']
    df['age_group']      = pd.cut(df['age'], bins=[0,40,60,75,200], labels=[0,1,2,3]).astype(int)
    return df

FEATURE_COLS = [
    'heart_rate', 'spo2', 'bp_systolic', 'bp_diastolic',
    'age', 'is_post_surgery', 'condition_code',
    'pulse_pressure', 'age_group',
]


# ── 3. Train ──────────────────────────────────────────────────────────────────

def train():
    print("🔬  Generating synthetic dataset …")
    df = generate_dataset(N_SAMPLES)
    df = engineer_features(df)

    X = df[FEATURE_COLS]
    y = df['risk']

    le = LabelEncoder()
    y_encoded = le.fit_transform(y)  # high=0, low=1, medium=2 (alphabetical)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y_encoded, test_size=0.2, random_state=RANDOM_SEED, stratify=y_encoded
    )

    print("🌲  Training Random Forest classifier …")
    model = RandomForestClassifier(
        n_estimators=200,
        max_depth=12,
        min_samples_split=4,
        class_weight='balanced',
        random_state=RANDOM_SEED,
        n_jobs=-1,
    )
    model.fit(X_train, y_train)

    # ── Evaluation ────────────────────────────────────────────────────────────
    y_pred = model.predict(X_test)
    acc    = accuracy_score(y_test, y_pred)
    print(f"\n✅  Accuracy: {acc * 100:.2f}%")
    print("\n📊  Classification Report:")
    print(classification_report(y_test, y_pred, target_names=le.classes_))

    # ── Feature importance ────────────────────────────────────────────────────
    importances = sorted(zip(FEATURE_COLS, model.feature_importances_), key=lambda x: -x[1])
    print("📌  Feature importances:")
    for feat, imp in importances:
        print(f"    {feat:<22} {imp:.4f}")

    # ── Save artefacts ────────────────────────────────────────────────────────
    joblib.dump(model, MODEL_PATH)
    joblib.dump(le,    ENCODER_PATH)
    print(f"\n💾  Model saved  → {MODEL_PATH}")
    print(f"💾  Encoder saved→ {ENCODER_PATH}\n")


if __name__ == '__main__':
    train()
