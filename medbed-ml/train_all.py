"""
train_all.py
─────────────────────────────────────────────────────────────────────────────
Master training script — generates datasets and trains all 3 models.

Usage:
    python train_all.py [--skip-data] [--model transfer|vitals|safety]

Options:
    --skip-data     Skip dataset generation (use existing CSVs)
    --model NAME    Train only one specific model
"""

import sys
import time
import argparse
from pathlib import Path

# ── Setup paths ───────────────────────────────────────────────────────────────
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))


def run_data_generation():
    print("\n" + "─" * 65)
    print("  STEP 1/4  Generating Synthetic Training Datasets")
    print("─" * 65)
    from data.generate_datasets import (
        generate_transfer_dataset,
        generate_vitals_dataset,
        generate_safety_dataset,
    )
    data_dir = ROOT / 'data'
    data_dir.mkdir(exist_ok=True)

    df1 = generate_transfer_dataset(6000)
    df1.to_csv(data_dir / 'transfer_dataset.csv', index=False)
    print(f"  ✅  transfer_dataset.csv — {len(df1)} rows")

    df2 = generate_vitals_dataset(1500, window=10)
    df2.to_csv(data_dir / 'vitals_dataset.csv', index=False)
    print(f"  ✅  vitals_dataset.csv   — {len(df2)} rows")

    df3 = generate_safety_dataset(5000)
    df3.to_csv(data_dir / 'safety_dataset.csv', index=False)
    print(f"  ✅  safety_dataset.csv   — {len(df3)} rows")


def run_transfer_model():
    print("\n" + "─" * 65)
    print("  STEP 2/4  Training Transfer Prediction Model")
    print("─" * 65)
    from models.transfer.train_transfer_model import train
    train()


def run_vitals_model():
    print("\n" + "─" * 65)
    print("  STEP 3/4  Training Vitals Deterioration Model (LSTM)")
    print("─" * 65)
    from models.vitals.train_vitals_model import train
    train()


def run_safety_model():
    print("\n" + "─" * 65)
    print("  STEP 4/4  Training Safety Prediction Model")
    print("─" * 65)
    from models.safety.train_safety_model import train
    train()


def run_quick_tests():
    """Run inference sanity checks on all trained models."""
    print("\n" + "─" * 65)
    print("  QUICK INFERENCE TESTS")
    print("─" * 65)

    # Transfer
    try:
        from models.transfer.train_transfer_model import TransferPredictor
        pred = TransferPredictor()
        result = pred.predict({
            'age': 67, 'weight_kg': 78.5, 'condition': 1,
            'department_from': 0, 'department_to': 1,
            'heart_rate': 102, 'spo2': 96,
            'bp_systolic': 128, 'bp_diastolic': 82,
            'transfer_distance': 180.0, 'time_of_day': 14,
            'is_post_surgery': 1, 'equipment_count': 2,
        })
        print(f"  ✅  Transfer  → Risk: {result['risk_label']}, "
              f"Staff: {result['staff_count']}, "
              f"Time: {result['estimated_minutes']:.0f} min")
    except Exception as e:
        print(f"  ❌  Transfer inference failed: {e}")

    # Vitals
    try:
        from models.vitals.train_vitals_model import VitalsPredictor
        pred = VitalsPredictor()
        result = pred.predict(
            hr   = [88,92,95,98,102,104,105,107,108,110],
            spo2 = [97,97,96,96,95,95,94,94,93,93],
            bp   = [118,120,122,124,126,128,130,131,132,133],
            age  = 67, condition = 1, is_post_surgery = 1,
        )
        print(f"  ✅  Vitals   → Alert: {result['alert_label']}, "
              f"Deterioration: {result['deterioration_prob']:.1%}")
    except Exception as e:
        print(f"  ❌  Vitals inference failed: {e}")

    # Safety
    try:
        from models.safety.train_safety_model import SafetyPredictor
        pred = SafetyPredictor()
        result = pred.predict({
            'weight_kg': 78.5, 'age': 67, 'is_sedated': 0,
            'sensor_head': 8.2, 'sensor_torso': 38.1,
            'sensor_leg_left': 16.4, 'sensor_leg_right': 14.8,
            'sensor_foot': 1.0,
            'accel_x': 0.05, 'accel_y': 0.02, 'accel_z': 9.80,
            'gyro_roll': 3.2, 'gyro_pitch': 1.1,
            'rail_left_locked': 0, 'rail_right_locked': 1,
            'bed_angle': 30.0, 'movement_30s': 4,
        })
        print(f"  ✅  Safety   → Fall: {result['fall_risk_label']} "
              f"({result['fall_risk_prob']:.1%}), "
              f"Imbalance: {result['imbalance_label']}, "
              f"Alert: {result['safety_alert_label']}")
    except Exception as e:
        print(f"  ❌  Safety inference failed: {e}")


# ── Main ──────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='MedBed OS — Train ML Models')
    parser.add_argument('--skip-data', action='store_true',
                        help='Skip dataset generation')
    parser.add_argument('--model', choices=['transfer','vitals','safety'],
                        help='Train only one model')
    args = parser.parse_args()

    t_total = time.time()

    print("\n" + "═" * 65)
    print("  MedBed OS — ML Training Pipeline")
    print("  3 models: Transfer · Vitals (LSTM) · Safety")
    print("═" * 65)

    # Step 1: Data
    if not args.skip_data:
        run_data_generation()
    else:
        print("\n  ⏭️   Skipping data generation (--skip-data)")

    # Step 2–4: Models
    if args.model == 'transfer' or not args.model:
        run_transfer_model()
    if args.model == 'vitals'   or not args.model:
        run_vitals_model()
    if args.model == 'safety'   or not args.model:
        run_safety_model()

    # Sanity tests
    run_quick_tests()

    elapsed = time.time() - t_total
    print(f"\n{'═' * 65}")
    print(f"  ✅  All done in {elapsed:.1f}s")
    print(f"  📁  Models saved in:  medbed-ml/models/")
    print(f"  🚀  Start API with:   uvicorn api.ml_api:app --port 8000")
    print("═" * 65 + "\n")
