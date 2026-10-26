"""
models/vitals/train_vitals_model.py
─────────────────────────────────────────────────────────────────────────────
Model 2: Vitals Deterioration Prediction
Architecture: Two-model ensemble
  A. LSTM (TensorFlow/Keras) — captures temporal deterioration patterns
  B. Gradient Boosting (scikit-learn) — statistical feature-based classification

Why LSTM?
  ✓ Naturally models sequential, time-ordered vitals data
  ✓ Learns long-range dependencies (slow-building crises)
  ✓ Hidden state captures history across monitoring window

Why ensemble?
  ✓ LSTM for temporal signals, GB for clinical features
  ✓ More robust than either alone

Run:
    python models/vitals/train_vitals_model.py

Outputs:
    models/vitals/lstm_model.h5
    models/vitals/gb_model.pkl
    models/vitals/scaler.pkl
    models/vitals/model_config.json
"""

import json
import joblib
import numpy as np
import pandas as pd
from pathlib import Path

from sklearn.ensemble import GradientBoostingClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.metrics import (
    classification_report, roc_auc_score, accuracy_score,
    mean_absolute_error
)

import tensorflow as tf
from tensorflow.keras.models import Sequential, Model
from tensorflow.keras.layers import (
    LSTM, Dense, Dropout, BatchNormalization,
    Input, Bidirectional, GlobalAveragePooling1D
)
from tensorflow.keras.callbacks import EarlyStopping, ReduceLROnPlateau
from tensorflow.keras.optimizers import Adam

# ── Paths ─────────────────────────────────────────────────────────────────────
ROOT      = Path(__file__).parent.parent.parent
DATA_PATH = ROOT / 'data' / 'vitals_dataset.csv'
MODEL_DIR = Path(__file__).parent
MODEL_DIR.mkdir(parents=True, exist_ok=True)

WINDOW       = 10   # time steps per sample
N_VITALS     = 3    # HR, SpO2, BP
ALERT_LABELS = {0: 'Normal', 1: 'Warning', 2: 'Critical'}


# ══════════════════════════════════════════════════════════════════════════════
# Data preparation
# ══════════════════════════════════════════════════════════════════════════════

def prepare_data(df: pd.DataFrame):
    """
    Returns:
        X_seq  (n, WINDOW, N_VITALS)  — LSTM input sequences
        X_feat (n, n_features)        — GB statistical features
        y_class (n,)                  — alert class 0/1/2
        y_prob  (n,)                  — deterioration probability
    """
    # ── Build sequences ────────────────────────────────────────────────────────
    hr_cols   = [f'hr_t{t}'   for t in range(WINDOW)]
    spo2_cols = [f'spo2_t{t}' for t in range(WINDOW)]
    bp_cols   = [f'bp_t{t}'   for t in range(WINDOW)]

    hr_arr   = df[hr_cols].values.astype(np.float32)
    spo2_arr = df[spo2_cols].values.astype(np.float32)
    bp_arr   = df[bp_cols].values.astype(np.float32)

    # Shape: (n_samples, window, 3_vitals)
    X_seq = np.stack([hr_arr, spo2_arr, bp_arr], axis=2)

    # ── Statistical features for GB ───────────────────────────────────────────
    def stats(arr, prefix):
        return {
            f'{prefix}_mean':   arr.mean(axis=1),
            f'{prefix}_std':    arr.std(axis=1),
            f'{prefix}_min':    arr.min(axis=1),
            f'{prefix}_max':    arr.max(axis=1),
            f'{prefix}_last':   arr[:, -1],
            f'{prefix}_trend':  arr[:, -1] - arr[:, 0],   # direction
            f'{prefix}_range':  arr.max(axis=1) - arr.min(axis=1),
        }

    feat_dict = {}
    feat_dict.update(stats(hr_arr,   'hr'))
    feat_dict.update(stats(spo2_arr, 'spo2'))
    feat_dict.update(stats(bp_arr,   'bp'))
    feat_dict['age']             = df['age'].values.astype(np.float32)
    feat_dict['condition']       = df['condition'].values.astype(np.float32)
    feat_dict['is_post_surgery'] = df['is_post_surgery'].values.astype(np.float32)

    X_feat   = pd.DataFrame(feat_dict).values.astype(np.float32)
    y_class  = df['alert_class'].values.astype(np.int32)
    y_prob   = df['deterioration_prob'].values.astype(np.float32)

    return X_seq, X_feat, y_class, y_prob


# ══════════════════════════════════════════════════════════════════════════════
# LSTM Architecture
# ══════════════════════════════════════════════════════════════════════════════

def build_lstm(window: int = WINDOW, n_vitals: int = N_VITALS,
               n_classes: int = 3) -> Model:
    """
    Bidirectional LSTM with attention-like pooling.
    Outputs both alert_class (softmax) and deterioration_prob (sigmoid).
    """
    inputs = Input(shape=(window, n_vitals), name='vitals_sequence')

    # Normalise each vital sign separately
    x = BatchNormalization()(inputs)

    # Bidirectional LSTM stack
    x = Bidirectional(LSTM(64, return_sequences=True, dropout=0.2))(x)
    x = BatchNormalization()(x)
    x = Bidirectional(LSTM(32, return_sequences=True, dropout=0.15))(x)

    # Global average pooling (lightweight attention proxy)
    x = GlobalAveragePooling1D()(x)

    # Dense head
    x = Dense(64, activation='relu')(x)
    x = Dropout(0.25)(x)
    x = Dense(32, activation='relu')(x)

    # Two output heads
    alert_out = Dense(n_classes, activation='softmax', name='alert_class')(x)
    prob_out  = Dense(1, activation='sigmoid', name='deteri_prob')(x)

    return Model(inputs=inputs, outputs=[alert_out, prob_out])


# ══════════════════════════════════════════════════════════════════════════════
# Training
# ══════════════════════════════════════════════════════════════════════════════

def train():
    print("=" * 65)
    print("  MedBed OS — Model 2: Vitals Deterioration Prediction")
    print("=" * 65)

    # ── Load data ─────────────────────────────────────────────────────────────
    print("\n📂  Loading vitals dataset…")
    df = pd.read_csv(DATA_PATH)
    print(f"    {len(df)} patient windows loaded")
    print(f"    alert_class: {df['alert_class'].value_counts().to_dict()}")

    X_seq, X_feat, y_class, y_prob = prepare_data(df)

    # ── Split ─────────────────────────────────────────────────────────────────
    idx = np.arange(len(df))
    train_idx, test_idx = train_test_split(idx, test_size=0.2,
                                           random_state=42, stratify=y_class)

    X_seq_train  = X_seq[train_idx];   X_seq_test  = X_seq[test_idx]
    X_feat_train = X_feat[train_idx];  X_feat_test = X_feat[test_idx]
    yc_train     = y_class[train_idx]; yc_test     = y_class[test_idx]
    yp_train     = y_prob[train_idx];  yp_test     = y_prob[test_idx]

    # ── Scale sequences ───────────────────────────────────────────────────────
    seq_scaler = StandardScaler()
    n_train, T, V = X_seq_train.shape
    X_seq_train_s = seq_scaler.fit_transform(
        X_seq_train.reshape(-1, V)).reshape(n_train, T, V)
    n_test = X_seq_test.shape[0]
    X_seq_test_s  = seq_scaler.transform(
        X_seq_test.reshape(-1, V)).reshape(n_test, T, V)

    # Scale features
    feat_scaler = StandardScaler()
    X_feat_train_s = feat_scaler.fit_transform(X_feat_train)
    X_feat_test_s  = feat_scaler.transform(X_feat_test)

    # ══════════════════════════════════════════════════════════════════════════
    # A. Train LSTM
    # ══════════════════════════════════════════════════════════════════════════
    print("\n🧠  Training LSTM model…")
    lstm_model = build_lstm()
    lstm_model.compile(
        optimizer = Adam(learning_rate=1e-3),
        loss = {
            'alert_class': 'sparse_categorical_crossentropy',
            'deteri_prob': 'mse',
        },
        loss_weights = {'alert_class': 1.0, 'deteri_prob': 0.5},
        metrics = {'alert_class': 'accuracy', 'deteri_prob': 'mae'},
    )
    lstm_model.summary()

    callbacks = [
        EarlyStopping(monitor='val_alert_class_accuracy', patience=10,
                      restore_best_weights=True, verbose=1),
        ReduceLROnPlateau(monitor='val_loss', factor=0.5, patience=5, verbose=1),
    ]

    # Class weights to handle imbalance
    class_counts = np.bincount(yc_train)
    class_weights = {i: len(yc_train) / (len(class_counts) * c)
                     for i, c in enumerate(class_counts)}
    print(f"    Class weights: {class_weights}")

    history = lstm_model.fit(
        X_seq_train_s,
        {'alert_class': yc_train, 'deteri_prob': yp_train},
        validation_split  = 0.15,
        epochs            = 60,
        batch_size        = 32,
        class_weight      = class_weights,
        callbacks         = callbacks,
        verbose           = 1,
    )

    # Evaluate LSTM
    lstm_preds = lstm_model.predict(X_seq_test_s, verbose=0)
    alert_proba_lstm = lstm_preds[0]       # shape (n_test, 3)
    prob_pred_lstm   = lstm_preds[1].ravel()
    alert_pred_lstm  = alert_proba_lstm.argmax(axis=1)

    print(f"\n📊  LSTM Results:")
    print(f"    Alert Classification:")
    print(classification_report(yc_test, alert_pred_lstm,
                                target_names=['Normal','Warning','Critical'],
                                digits=4))
    print(f"    Deterioration MAE : {mean_absolute_error(yp_test, prob_pred_lstm):.4f}")
    try:
        auc = roc_auc_score(yc_test, alert_proba_lstm, multi_class='ovr')
        print(f"    ROC AUC (OvR)     : {auc:.4f}")
    except Exception:
        pass

    # ══════════════════════════════════════════════════════════════════════════
    # B. Train Gradient Boosting (feature-based ensemble partner)
    # ══════════════════════════════════════════════════════════════════════════
    print("\n🌲  Training Gradient Boosting (statistical features)…")
    gb_model = GradientBoostingClassifier(
        n_estimators  = 200,
        learning_rate = 0.08,
        max_depth     = 4,
        subsample     = 0.85,
        random_state  = 42,
    )
    gb_model.fit(X_feat_train_s, yc_train)
    gb_pred  = gb_model.predict(X_feat_test_s)
    gb_proba = gb_model.predict_proba(X_feat_test_s)

    print(f"\n📊  GB Results:")
    print(classification_report(yc_test, gb_pred,
                                target_names=['Normal','Warning','Critical'],
                                digits=4))

    # ══════════════════════════════════════════════════════════════════════════
    # C. Ensemble: weighted average of probabilities
    # ══════════════════════════════════════════════════════════════════════════
    LSTM_WEIGHT = 0.60
    GB_WEIGHT   = 0.40
    ensemble_proba = (LSTM_WEIGHT * alert_proba_lstm +
                      GB_WEIGHT   * gb_proba)
    ensemble_pred  = ensemble_proba.argmax(axis=1)
    acc_ensemble   = accuracy_score(yc_test, ensemble_pred)

    print(f"\n🔀  Ensemble ({LSTM_WEIGHT:.0%} LSTM + {GB_WEIGHT:.0%} GB):")
    print(f"    Accuracy : {acc_ensemble:.4f}")
    print(classification_report(yc_test, ensemble_pred,
                                target_names=['Normal','Warning','Critical'],
                                digits=4))

    # ── Save all artefacts ────────────────────────────────────────────────────
    lstm_model.save(MODEL_DIR / 'lstm_model.h5')
    joblib.dump(gb_model,    MODEL_DIR / 'gb_model.pkl')
    joblib.dump(seq_scaler,  MODEL_DIR / 'seq_scaler.pkl')
    joblib.dump(feat_scaler, MODEL_DIR / 'feat_scaler.pkl')

    config = {
        'window':        WINDOW,
        'n_vitals':      N_VITALS,
        'alert_labels':  ALERT_LABELS,
        'lstm_weight':   LSTM_WEIGHT,
        'gb_weight':     GB_WEIGHT,
        'lstm_acc':      float(accuracy_score(yc_test, alert_pred_lstm)),
        'gb_acc':        float(accuracy_score(yc_test, gb_pred)),
        'ensemble_acc':  float(acc_ensemble),
    }
    with open(MODEL_DIR / 'model_config.json', 'w') as f:
        json.dump(config, f, indent=2)

    print(f"\n💾  Saved to {MODEL_DIR}/")
    print("    lstm_model.h5 · gb_model.pkl · seq_scaler.pkl · feat_scaler.pkl\n")


# ══════════════════════════════════════════════════════════════════════════════
# Inference wrapper
# ══════════════════════════════════════════════════════════════════════════════

class VitalsPredictor:
    """
    Production inference. Accepts a dict of time-series vitals,
    returns ensemble prediction.
    """

    def __init__(self, model_dir: Path = MODEL_DIR):
        self.lstm_model  = tf.keras.models.load_model(model_dir / 'lstm_model.h5')
        self.gb_model    = joblib.load(model_dir / 'gb_model.pkl')
        self.seq_scaler  = joblib.load(model_dir / 'seq_scaler.pkl')
        self.feat_scaler = joblib.load(model_dir / 'feat_scaler.pkl')
        with open(model_dir / 'model_config.json') as f:
            self.cfg = json.load(f)

    def _build_features(self, hr: list, spo2: list, bp: list,
                        age: int, condition: int, is_post_surgery: int):
        def stats(arr, prefix):
            arr = np.array(arr, dtype=np.float32)
            return {
                f'{prefix}_mean':  arr.mean(),  f'{prefix}_std':   arr.std(),
                f'{prefix}_min':   arr.min(),   f'{prefix}_max':   arr.max(),
                f'{prefix}_last':  arr[-1],     f'{prefix}_trend': arr[-1]-arr[0],
                f'{prefix}_range': arr.max()-arr.min(),
            }
        feat = {}
        feat.update(stats(hr,   'hr'))
        feat.update(stats(spo2, 'spo2'))
        feat.update(stats(bp,   'bp'))
        feat['age']             = float(age)
        feat['condition']       = float(condition)
        feat['is_post_surgery'] = float(is_post_surgery)
        return np.array(list(feat.values()), dtype=np.float32).reshape(1, -1)

    def predict(self, hr: list, spo2: list, bp: list,
                age: int = 60, condition: int = 0,
                is_post_surgery: int = 0) -> dict:
        W, V = self.cfg['window'], self.cfg['n_vitals']

        # Pad/trim to window
        hr   = (hr   + [hr[-1]]   * W)[:W]
        spo2 = (spo2 + [spo2[-1]] * W)[:W]
        bp   = (bp   + [bp[-1]]   * W)[:W]

        # LSTM sequence
        seq = np.stack([hr, spo2, bp], axis=1).reshape(1, W, V).astype(np.float32)
        seq_s = self.seq_scaler.transform(seq.reshape(-1, V)).reshape(1, W, V)

        lstm_out   = self.lstm_model.predict(seq_s, verbose=0)
        lstm_proba = lstm_out[0][0]   # (3,)
        deteri_prob= float(lstm_out[1][0][0])

        # GB features
        X_feat = self._build_features(hr, spo2, bp, age, condition, is_post_surgery)
        X_feat_s = self.feat_scaler.transform(X_feat)
        gb_proba  = self.gb_model.predict_proba(X_feat_s)[0]

        # Ensemble
        lw  = self.cfg['lstm_weight']
        gw  = self.cfg['gb_weight']
        ens = lw * lstm_proba + gw * gb_proba
        cls = int(ens.argmax())

        return {
            'alert_class':        cls,
            'alert_label':        self.cfg['alert_labels'][str(cls)],
            'deterioration_prob': round(deteri_prob, 4),
            'probabilities': {
                'Normal':   round(float(ens[0]), 4),
                'Warning':  round(float(ens[1]), 4),
                'Critical': round(float(ens[2]), 4),
            },
        }


if __name__ == '__main__':
    train()
