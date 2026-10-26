"""
data/generate_datasets.py
─────────────────────────────────────────────────────────────────────────────
Generates three realistic synthetic CSV datasets for MedBed OS ML training.

Run:
    python data/generate_datasets.py

Outputs:
    data/transfer_dataset.csv
    data/vitals_dataset.csv
    data/safety_dataset.csv
"""

import numpy as np
import pandas as pd
from pathlib import Path

RNG  = np.random.default_rng(seed=42)
OUT  = Path(__file__).parent

# ══════════════════════════════════════════════════════════════════════════════
# 1. PATIENT TRANSFER DATASET
#    Predicts: staff_count, risk_level, estimated_minutes
# ══════════════════════════════════════════════════════════════════════════════

def generate_transfer_dataset(n: int = 6000) -> pd.DataFrame:
    """
    Features
    ────────
    age               int     Patient age (18–95)
    weight_kg         float   Patient weight (40–160 kg)
    condition         int     0=General, 1=Cardiac, 2=Respiratory, 3=Neuro, 4=ICU
    department_from   int     0=Ward, 1=ICU, 2=OT, 3=Emergency, 4=Radiology
    department_to     int     0=Ward, 1=ICU, 2=OT, 3=Emergency, 4=Radiology
    heart_rate        int     bpm
    spo2              int     %
    bp_systolic       int     mmHg
    bp_diastolic      int     mmHg
    transfer_distance float   metres (10–500)
    time_of_day       int     hour 0–23
    is_post_surgery   int     0/1
    equipment_count   int     0–5 (IV lines, monitors, etc.)

    Targets
    ───────
    staff_count       int     1–4
    risk_level        int     0=Low, 1=Medium, 2=High
    estimated_minutes int     5–60
    """
    age              = RNG.integers(18, 95, n)
    weight_kg        = RNG.uniform(40, 160, n).round(1)
    condition        = RNG.choice([0,1,2,3,4], n, p=[0.30,0.25,0.15,0.15,0.15])
    dept_from        = RNG.choice([0,1,2,3,4], n, p=[0.40,0.25,0.15,0.10,0.10])
    dept_to          = RNG.choice([0,1,2,3,4], n, p=[0.30,0.30,0.20,0.10,0.10])
    heart_rate       = RNG.integers(45, 155, n)
    spo2             = RNG.integers(82, 100, n)
    bp_systolic      = RNG.integers(80, 200, n)
    bp_diastolic     = (bp_systolic * 0.63 + RNG.normal(0, 8, n)).clip(40, 130).astype(int)
    distance         = RNG.uniform(10, 500, n).round(1)
    time_of_day      = RNG.integers(0, 24, n)
    is_post_surgery  = RNG.choice([0, 1], n, p=[0.6, 0.4])
    equipment_count  = RNG.integers(0, 6, n)

    # ── Rule-based risk scoring ───────────────────────────────────────────────
    risk_score = np.zeros(n)
    risk_score += (heart_rate > 110).astype(int) * 2
    risk_score += (heart_rate > 130).astype(int) * 2
    risk_score += (spo2 < 94).astype(int) * 2
    risk_score += (spo2 < 88).astype(int) * 2
    risk_score += (bp_systolic > 160).astype(int) * 1
    risk_score += (bp_systolic < 90).astype(int) * 2
    risk_score += (age > 70).astype(int)
    risk_score += (condition == 4).astype(int) * 2   # ICU condition
    risk_score += (condition == 1).astype(int)        # Cardiac
    risk_score += is_post_surgery
    risk_score += (dept_to == 1).astype(int)          # Transferring to ICU
    risk_score += (equipment_count >= 3).astype(int)
    risk_score += RNG.normal(0, 0.5, n)               # noise

    risk_level = np.where(risk_score >= 6, 2,         # High
                 np.where(risk_score >= 3, 1, 0))      # Medium / Low

    # ── Derive staff count from risk + weight + equipment ────────────────────
    staff_base = 1 + (risk_level >= 1).astype(int) + (risk_level == 2).astype(int)
    staff_count = (staff_base + (weight_kg > 100).astype(int)
                              + (equipment_count >= 3).astype(int)).clip(1, 4)

    # ── Estimated transfer time ───────────────────────────────────────────────
    speed_mpm     = np.where(risk_level == 2, 15, np.where(risk_level == 1, 25, 40))
    base_minutes  = (distance / speed_mpm).round().astype(int)
    equip_penalty = equipment_count * 2
    age_penalty   = ((age > 75).astype(int)) * 3
    est_minutes   = (base_minutes + equip_penalty + age_penalty
                     + RNG.integers(-2, 5, n)).clip(5, 60)

    return pd.DataFrame({
        'age':              age,
        'weight_kg':        weight_kg,
        'condition':        condition,
        'department_from':  dept_from,
        'department_to':    dept_to,
        'heart_rate':       heart_rate,
        'spo2':             spo2,
        'bp_systolic':      bp_systolic,
        'bp_diastolic':     bp_diastolic,
        'transfer_distance':distance,
        'time_of_day':      time_of_day,
        'is_post_surgery':  is_post_surgery,
        'equipment_count':  equipment_count,
        # Targets
        'staff_count':      staff_count,
        'risk_level':       risk_level,
        'estimated_minutes':est_minutes,
    })


# ══════════════════════════════════════════════════════════════════════════════
# 2. VITALS TIME-SERIES DATASET
#    Predicts: deterioration_prob, alert_class
# ══════════════════════════════════════════════════════════════════════════════

def generate_vitals_dataset(n_patients: int = 1500,
                             window: int = 10) -> pd.DataFrame:
    """
    Each row = one patient time-window (10 readings → 30 feature columns).

    Features (per reading × window size):
        hr_t0..hr_t9       Heart rate at each time step
        spo2_t0..spo2_t9   SpO2
        bp_t0..bp_t9       BP systolic

    Additional context features:
        age, condition, is_post_surgery

    Targets:
        deterioration_prob  float   0.0–1.0
        alert_class         int     0=Normal, 1=Warning, 2=Critical
    """
    rows = []

    for _ in range(n_patients):
        # Decide patient baseline
        base_hr  = RNG.integers(60, 100)
        base_spo2= RNG.integers(93, 100)
        base_bp  = RNG.integers(100, 140)
        age      = int(RNG.integers(18, 90))
        condition= int(RNG.choice([0,1,2,3,4]))
        post_surg= int(RNG.choice([0, 1], p=[0.6, 0.4]))

        # Decide trajectory: stable, declining, critical
        traj = RNG.choice(['stable','declining','critical'], p=[0.50, 0.30, 0.20])

        hr_series   = []
        spo2_series = []
        bp_series   = []

        for t in range(window):
            if traj == 'stable':
                hr   = int(np.clip(base_hr   + RNG.normal(0, 3), 45, 140))
                spo2 = int(np.clip(base_spo2 + RNG.normal(0, 1), 88, 100))
                bp   = int(np.clip(base_bp   + RNG.normal(0, 5), 80, 180))
            elif traj == 'declining':
                hr   = int(np.clip(base_hr   + t * 2   + RNG.normal(0, 3), 45, 160))
                spo2 = int(np.clip(base_spo2 - t * 0.5 + RNG.normal(0, 1), 80, 100))
                bp   = int(np.clip(base_bp   + t * 3   + RNG.normal(0, 5), 80, 200))
            else:  # critical
                hr   = int(np.clip(base_hr   + t * 4   + RNG.normal(0, 5), 45, 180))
                spo2 = int(np.clip(base_spo2 - t * 1.2 + RNG.normal(0, 2), 70, 100))
                bp   = int(np.clip(base_bp   + t * 5   + RNG.normal(0, 8), 60, 220))

            hr_series.append(hr)
            spo2_series.append(spo2)
            bp_series.append(bp)

        # ── Compute deterioration probability ─────────────────────────────────
        final_hr, final_spo2, final_bp = hr_series[-1], spo2_series[-1], bp_series[-1]
        score = 0.0
        score += min((final_hr  - 90) / 60,  1.0) if final_hr  > 90  else 0
        score += min((95 - final_spo2) / 20, 1.0) if final_spo2 < 95 else 0
        score += min((final_bp  - 130) / 80, 1.0) if final_bp  > 130 else 0
        # Trend bonus
        if hr_series[-1] > hr_series[0]:   score += 0.15
        if spo2_series[-1] < spo2_series[0]: score += 0.20
        deteri_prob = float(np.clip(score / 3 + RNG.normal(0, 0.05), 0, 1))
        deteri_prob = round(deteri_prob, 4)

        # ── Alert class ────────────────────────────────────────────────────────
        if traj == 'critical' or deteri_prob > 0.65:
            alert_class = 2
        elif traj == 'declining' or deteri_prob > 0.30:
            alert_class = 1
        else:
            alert_class = 0

        row = {}
        for t in range(window):
            row[f'hr_t{t}']   = hr_series[t]
            row[f'spo2_t{t}'] = spo2_series[t]
            row[f'bp_t{t}']   = bp_series[t]
        row['age']               = age
        row['condition']         = condition
        row['is_post_surgery']   = post_surg
        row['deterioration_prob']= deteri_prob
        row['alert_class']       = alert_class
        rows.append(row)

    return pd.DataFrame(rows)


# ══════════════════════════════════════════════════════════════════════════════
# 3. WEIGHT & PRESSURE SAFETY DATASET
#    Predicts: fall_risk_prob, imbalance_detected, safety_alert
# ══════════════════════════════════════════════════════════════════════════════

def generate_safety_dataset(n: int = 5000) -> pd.DataFrame:
    """
    Features
    ────────
    weight_kg            float   Patient weight
    age                  int
    is_sedated           int     0/1
    sensor_head          float   Pressure reading — head zone (0–100 kg equiv.)
    sensor_torso         float   Torso zone
    sensor_leg_left      float   Left leg
    sensor_leg_right     float   Right leg
    sensor_foot          float   Foot zone
    accel_x              float   Accelerometer X (movement)
    accel_y              float   Accelerometer Y
    accel_z              float   Accelerometer Z
    gyro_roll            float   Gyroscope roll angle (degrees)
    gyro_pitch           float   Pitch angle
    rail_left_locked     int     0/1
    rail_right_locked    int     0/1
    bed_angle            float   Head-of-bed elevation (degrees)
    movement_30s         int     Number of movements in last 30 seconds

    Targets
    ───────
    fall_risk_prob       float   0.0–1.0
    imbalance_detected   int     0/1
    safety_alert         int     0=Safe, 1=Warning, 2=Critical
    """
    weight_kg       = RNG.uniform(40, 160, n).round(1)
    age             = RNG.integers(18, 95, n)
    is_sedated      = RNG.choice([0, 1], n, p=[0.7, 0.3])

    # Pressure sensors — sum ≈ weight_kg (with noise)
    torso_frac = RNG.uniform(0.3, 0.5, n)
    head_frac  = RNG.uniform(0.05, 0.15, n)
    leg_l_frac = RNG.uniform(0.1, 0.25, n)
    leg_r_frac = RNG.uniform(0.1, 0.25, n)
    foot_frac  = 1 - torso_frac - head_frac - leg_l_frac - leg_r_frac
    foot_frac  = foot_frac.clip(0.01, 0.3)

    sensor_head      = (weight_kg * head_frac  + RNG.normal(0, 1, n)).clip(0)
    sensor_torso     = (weight_kg * torso_frac + RNG.normal(0, 2, n)).clip(0)
    sensor_leg_left  = (weight_kg * leg_l_frac + RNG.normal(0, 1, n)).clip(0)
    sensor_leg_right = (weight_kg * leg_r_frac + RNG.normal(0, 1, n)).clip(0)
    sensor_foot      = (weight_kg * foot_frac  + RNG.normal(0, 1, n)).clip(0)

    # Introduce imbalance for some patients
    imbalance_detected = RNG.choice([0, 1], n, p=[0.75, 0.25])
    # Skew left/right for imbalanced cases
    shift = imbalance_detected * RNG.uniform(10, 40, n)
    sensor_leg_left  = np.where(imbalance_detected, sensor_leg_left + shift, sensor_leg_left)
    sensor_leg_right = np.where(imbalance_detected, sensor_leg_right - shift * 0.5, sensor_leg_right).clip(0)

    # Movement / gyroscope
    movement_30s = RNG.integers(0, 20, n)
    accel_x      = RNG.normal(0, 0.3, n) + movement_30s * 0.05
    accel_y      = RNG.normal(0, 0.3, n) + movement_30s * 0.03
    accel_z      = RNG.normal(9.81, 0.2, n)
    gyro_roll    = RNG.normal(0, 5, n) + imbalance_detected * RNG.uniform(5, 25, n)
    gyro_pitch   = RNG.normal(0, 3, n) + movement_30s * 0.2

    rail_left_locked  = RNG.choice([0, 1], n, p=[0.2, 0.8])
    rail_right_locked = RNG.choice([0, 1], n, p=[0.15, 0.85])
    bed_angle         = RNG.uniform(0, 45, n).round(1)

    # ── Fall risk probability ─────────────────────────────────────────────────
    fall_score = np.zeros(n)
    fall_score += (movement_30s > 10).astype(float) * 0.25
    fall_score += (movement_30s > 15).astype(float) * 0.20
    fall_score += (~rail_left_locked.astype(bool)).astype(float) * 0.15
    fall_score += (~rail_right_locked.astype(bool)).astype(float) * 0.15
    fall_score += imbalance_detected.astype(float) * 0.20
    fall_score += (age > 70).astype(float) * 0.10
    fall_score += (~is_sedated.astype(bool)).astype(float) * 0.05
    fall_score += (np.abs(gyro_roll) > 20).astype(float) * 0.20
    fall_score += RNG.uniform(0, 0.1, n)  # noise

    fall_risk_prob = fall_score.clip(0, 1).round(4)

    # ── Safety alert class ────────────────────────────────────────────────────
    safety_alert = np.where(fall_risk_prob > 0.65, 2,
                   np.where(fall_risk_prob > 0.35, 1, 0))

    return pd.DataFrame({
        'weight_kg':         weight_kg.round(1),
        'age':               age,
        'is_sedated':        is_sedated,
        'sensor_head':       sensor_head.round(2),
        'sensor_torso':      sensor_torso.round(2),
        'sensor_leg_left':   sensor_leg_left.round(2),
        'sensor_leg_right':  sensor_leg_right.round(2),
        'sensor_foot':       sensor_foot.round(2),
        'accel_x':           accel_x.round(4),
        'accel_y':           accel_y.round(4),
        'accel_z':           accel_z.round(4),
        'gyro_roll':         gyro_roll.round(2),
        'gyro_pitch':        gyro_pitch.round(2),
        'rail_left_locked':  rail_left_locked,
        'rail_right_locked': rail_right_locked,
        'bed_angle':         bed_angle,
        'movement_30s':      movement_30s,
        # Targets
        'fall_risk_prob':    fall_risk_prob,
        'imbalance_detected':imbalance_detected,
        'safety_alert':      safety_alert,
    })


# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == '__main__':
    print("🔬  Generating MedBed OS training datasets…\n")

    # Transfer dataset
    df_transfer = generate_transfer_dataset(6000)
    df_transfer.to_csv(OUT / 'transfer_dataset.csv', index=False)
    print(f"✅  transfer_dataset.csv    — {len(df_transfer)} rows, {len(df_transfer.columns)} columns")
    print(f"    risk_level distribution: {df_transfer['risk_level'].value_counts().to_dict()}")
    print(f"    staff_count distribution: {df_transfer['staff_count'].value_counts().to_dict()}\n")

    # Sample rows
    print("    Sample rows:")
    print(df_transfer.head(3).to_string(index=False))
    print()

    # Vitals dataset
    df_vitals = generate_vitals_dataset(1500, window=10)
    df_vitals.to_csv(OUT / 'vitals_dataset.csv', index=False)
    print(f"✅  vitals_dataset.csv      — {len(df_vitals)} rows, {len(df_vitals.columns)} columns")
    print(f"    alert_class distribution: {df_vitals['alert_class'].value_counts().to_dict()}\n")

    # Safety dataset
    df_safety = generate_safety_dataset(5000)
    df_safety.to_csv(OUT / 'safety_dataset.csv', index=False)
    print(f"✅  safety_dataset.csv      — {len(df_safety)} rows, {len(df_safety.columns)} columns")
    print(f"    safety_alert distribution: {df_safety['safety_alert'].value_counts().to_dict()}")
    print(f"    imbalance_detected rate: {df_safety['imbalance_detected'].mean():.1%}\n")
    print("💾  All datasets saved to data/")
