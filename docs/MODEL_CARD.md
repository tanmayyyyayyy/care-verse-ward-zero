# Model Card: 24–48h Patient Deterioration Risk Trend Model (Experimental)

## 1. Model Details
- **Model Name:** Ward Zero Vitals Deterioration Trend Classifier
- **Model Architecture:** Gradient Boosting Classifier (`scikit-learn` `GradientBoostingClassifier`, 120 estimators, max depth 4, learning rate 0.08, subsample 0.85).
- **Service Endpoint:** `POST /predict/trend` in `ai-service/api.py` (microservice port 8000).
- **Target:** 3-class future physiological deterioration risk:
  - `high`: Severe decompensation in the subsequent 24–48 hours (projected NEWS2 $\ge$ 7, $\text{SpO}_2 < 88\%$, or Systolic BP $< 85\text{ mmHg}$).
  - `medium`: Moderate clinical deterioration in the subsequent 24–48 hours (projected NEWS2 $\ge$ 5, $\text{SpO}_2 < 93\%$, or Systolic BP $< 100\text{ mmHg}$).
  - `low`: Clinically stable trajectory maintained throughout the future horizon.
- **Prediction Horizon:** 24 to 48 hours forward in time from current observation window.
- **Training Artifacts:**
  - Model weights: `medbed-fullstack/ai-service/trend_model.pkl`
  - Feature schema: `medbed-fullstack/ai-service/trend_features.json`
  - Metrics record: `medbed-fullstack/ai-service/trend_metrics.json`

---

## 2. Intended Use & Scope
- **Intended Purpose:** Prototype early warning and caregiver decision support system for home healthcare and bedroom hospital wards (Operation Ward Zero Hackathon).
- **Non-intended Uses:** Not an FDA-cleared or CE-marked medical device. Must **never** be used for autonomous clinical triage, medication administration, or life-support decisions without licensed human clinician oversight.

---

## 3. Features & Inputs (30 Total Features)
Features are extracted over a chronological observation window (minimum 5 readings, up to 48 hours):

1. **Slopes (per hour):**
   - `hr_slope` (Heart rate slope in bpm/h)
   - `spo2_slope` ($\text{SpO}_2$ slope in %/h)
   - `bp_sys_slope` (Systolic BP slope in mmHg/h)
   - `rr_slope` (Respiratory rate slope in breaths/min/h)
   - `temp_slope` (Body temperature slope in °C/h)
2. **Rolling Summary Statistics:**
   - Rolling mean: `mean_hr`, `mean_spo2`, `mean_bp`, `mean_rr`
   - Rolling standard deviation: `std_hr`, `std_spo2`, `std_bp`, `std_rr`
3. **Physiological Variability / Instability:**
   - `cv_hr` (Coefficient of variation: $\text{std}(\text{HR}) / \text{mean}(\text{HR})$)
   - `cv_spo2` (Coefficient of variation: $\text{std}(\text{SpO}_2) / \text{mean}(\text{SpO}_2)$)
4. **Time Below / Above Critical Thresholds:**
   - `hours_spo2_below_92` (Cumulative hours $\text{SpO}_2 < 92\%$)
   - `hours_sys_below_90` (Cumulative hours Systolic BP $< 90\text{ mmHg}$)
   - `hours_hr_above_100` (Cumulative hours HR $> 100\text{ bpm}$)
   - `hours_rr_above_24` (Cumulative hours RR $> 24\text{ bpm}$)
5. **NEWS2-Style Rolling Metrics:**
   - `news_latest` (Most recent vital signs NEWS2 score: 0–14)
   - `news_mean` (Rolling average NEWS2 across window)
   - `news_max` (Peak NEWS2 score across window)
   - `news_slope` (Rate of change of NEWS2 score per hour)
6. **Patient Baseline Deviation:**
   - `hr_delta_baseline` (Current HR minus patient's personalized baseline HR)
   - `spo2_delta_baseline` (Current $\text{SpO}_2$ minus personalized baseline $\text{SpO}_2$)
   - `bp_delta_baseline` (Current Systolic BP minus personalized baseline SBP)
   - `rr_delta_baseline` (Current RR minus personalized baseline RR)
7. **Context & Demographics:**
   - `age` (Years, normalized)
   - `is_post_surgery` (Binary indicator)
   - `condition_risk` (High-risk diagnostic category indicator: cardiac, respiratory, ICU)

---

## 4. Synthetic Data Generation Assumptions
All training and evaluation data is 100% synthetic, generated forward in time without retroactive hindsight:
1. **Longitudinal Trajectories:** 400 simulated patient admissions over 72 continuous hours each with 1-hour resolution.
2. **Circadian Modulation:** 24-hour sinusoidal rhythms applied to baseline vitals (HR $\pm 3\text{ bpm}$, BP $\pm 4\text{ mmHg}$, Temp $\pm 0.2^\circ\text{C}$).
3. **Stochastic Physiological Noise:** Gaussian variations mimicking sensor noise and transient patient movement.
4. **Physiological Deterioration Patterns:**
   - *Gradual Respiratory Decline:* Progressive subclinical drift in $\text{SpO}_2$ starting hour 12, accompanied by compensatory tachypnea ($\text{RR} \uparrow$) and tachycardia ($\text{HR} \uparrow$).
   - *Hemodynamic Instability / Sepsis:* Progressive vasodilation leading to BP collapse, refractory tachycardia, and hyperthermia.
   - *Transient Fluctuation:* Reversible vital sign perturbation (hours 20–32) resolving back to baseline without 48h adverse outcome.
   - *Stable Control:* Normal physiological bounds maintained throughout the 72h window.

---

## 5. Evaluation Method & Split Strategy
- **Split Scheme:** Strict chronological patient cohort split with **zero temporal or patient-level leakage**.
  - **Train set:** Patients 0 to 279 (70% of cohort, 280 longitudinal samples).
  - **Test set:** Patients 280 to 399 (30% of cohort, 120 longitudinal samples).
- **No Overlap:** No patient observations or sliding window segments cross between training and test sets.

---

## 6. Reproducible Metrics From Run
Metrics generated by executing `python train_trend.py` in `ai-service` on macOS ARM64:

```bash
cd medbed-fullstack/ai-service && source .venv/bin/activate && python train_trend.py
```

### Global Test Set Performance (720 samples across patients 280–399)
| Metric | Value |
| :--- | :--- |
| **Accuracy** | **0.8722** (628 / 720 correct) |
| **Macro F1-Score** | **0.8373** |
| **Weighted F1-Score** | **0.8662** |
| **Macro ROC-AUC (OVR)** | **0.9408** |

### Per-Class Detailed Breakdown (Test Set)
| Class | Precision | Recall | F1-Score | Support |
| :--- | :--- | :--- | :--- | :--- |
| **Low Risk** | 0.8798 | 0.9600 | 0.9182 | 450 |
| **Medium Risk** | 0.7542 | 0.5855 | 0.6593 | 152 |
| **High Risk** | 0.9640 | 0.9068 | 0.9345 | 118 |

### Top Gini Feature Importances
1. `rr_delta_baseline` (0.2675) — Current respiratory rate shift above personalized baseline
2. `mean_bp` (0.1195) — Mean arterial systolic pressure
3. `news_latest` (0.0836) — Most recent NEWS2 vital signs score
4. `spo2_delta_baseline` (0.0567) — Shift in $\text{SpO}_2$ relative to baseline
5. `hr_delta_baseline` (0.0513) — Shift in HR relative to baseline
6. `mean_rr` (0.0394) — Rolling average respiratory rate
7. `temp_slope` (0.0381) — Rate of body temperature change per hour
8. `mean_spo2` (0.0369) — Rolling average $\text{SpO}_2$

---

## 7. Limitations & Operational Safeguards
1. **Synthetic Data Only:** Trained strictly on forward-generated synthetic physiological models. Does not reflect real patient clinical noise such as sensor disconnects, motion artifacts, or medication kinetics.
2. **Insufficient Data Rejection:** If fewer than 5 readings are present or if data is stale (> 3 hours elapsed), the service returns `risk_level: "insufficient_data"`. It **never defaults to low risk** when data is missing.
3. **Deterministic Fallback:** If the ML service is down or times out, the backend invokes a transparent rule-based early warning fallback tagged `source: "rule"`.
4. **Clinical Disclaimer:** All dashboard and API outputs are labeled *"Experimental — synthetic data"*.
