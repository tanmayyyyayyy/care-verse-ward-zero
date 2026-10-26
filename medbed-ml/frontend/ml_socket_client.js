// frontend/ml_socket_client.js
// ─────────────────────────────────────────────────────────────────────────────
// Drop-in Socket.IO client that receives ML predictions from the backend
// and updates the MedBed OS dashboard UI in real-time.
//
// Add to index.html AFTER auth.js:
//   <script src="https://cdn.socket.io/4.6.0/socket.io.min.js"></script>
//   <script src="ml_socket_client.js"></script>
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const TOKEN    = localStorage.getItem('medbed_token');
  const BACKEND  = 'http://localhost:5000';

  if (!TOKEN) return; // auth.js handles redirect

  // ── Connect socket ────────────────────────────────────────────────────────
  const socket = io(BACKEND, {
    auth: { token: TOKEN },
    reconnectionAttempts: 5,
    reconnectionDelay:    2000,
  });

  window.medbedSocket = socket; // expose for manual use

  socket.on('connect',       () => console.log('🔌 ML Socket connected'));
  socket.on('connect_error', (e) => console.warn('Socket error:', e.message));


  // ══════════════════════════════════════════════════════════════════════════
  // Handler: ml:vitals_prediction
  // Fired when server receives vitals:push and runs the vitals LSTM model
  // ══════════════════════════════════════════════════════════════════════════
  socket.on('ml:vitals_prediction', (data) => {
    const { patientId, vitals, prediction } = data;
    const { alert_class, alert_label, deterioration_prob, probabilities } = prediction;

    // ── Update live vitals display ────────────────────────────────────────
    const hrEl   = document.getElementById('hrVal');
    const o2El   = document.getElementById('spo2Val');
    const hrVVal = document.getElementById('hrVVal');
    const o2VVal = document.getElementById('spo2VVal');

    if (vitals) {
      if (hrEl)   hrEl.textContent   = vitals.heartRate;
      if (o2El)   o2El.textContent   = vitals.spo2;
      if (hrVVal) hrVVal.textContent = vitals.heartRate;
      if (o2VVal) o2VVal.textContent = vitals.spo2;
    }

    // ── Update alert banner based on ML prediction ────────────────────────
    updateVitalsAlertBanner('hr',   alert_class, alert_label, vitals?.heartRate, 'bpm');
    updateVitalsAlertBanner('spo2', alert_class, alert_label, vitals?.spo2,       '%');

    // ── Update deterioration risk indicator ───────────────────────────────
    const riskEl = document.getElementById('deteriorationRisk');
    if (riskEl) {
      riskEl.textContent = `${(deterioration_prob * 100).toFixed(0)}%`;
      riskEl.style.color = deterioration_prob > 0.65 ? 'var(--red)'
                         : deterioration_prob > 0.35 ? 'var(--yellow)'
                         : 'var(--green)';
    }

    // ── Show toast for alerts ─────────────────────────────────────────────
    if (alert_class === 2) {
      showMLToast(
        `🚨 CRITICAL: Vitals deteriorating — ${(deterioration_prob*100).toFixed(0)}% risk`,
        'crit'
      );
    } else if (alert_class === 1 && deterioration_prob > 0.4) {
      showMLToast(`⚠️ Warning: ${alert_label} vitals detected`, 'warn');
    }

    // ── Update AI recommendations panel ──────────────────────────────────
    injectMLRecommendation('vitals', {
      alert_class, alert_label, deterioration_prob, probabilities,
    });
  });


  // ══════════════════════════════════════════════════════════════════════════
  // Handler: ml:safety_prediction
  // Fired when server receives safety:push and runs the safety model
  // ══════════════════════════════════════════════════════════════════════════
  socket.on('ml:safety_prediction', (data) => {
    const { patientId, bedId, prediction } = data;
    const {
      fall_risk_prob, fall_risk_label,
      imbalance_detected, safety_alert, safety_alert_label,
    } = prediction;

    // ── Update fall risk indicator ────────────────────────────────────────
    const fallEl = document.getElementById('fallRiskValue');
    if (fallEl) {
      fallEl.textContent = `${(fall_risk_prob * 100).toFixed(0)}%`;
      fallEl.style.color = fall_risk_prob > 0.65 ? 'var(--red)'
                         : fall_risk_prob > 0.35 ? 'var(--yellow)'
                         : 'var(--green)';
    }

    // ── Update safety status badge ────────────────────────────────────────
    const safetyBadge = document.querySelector('.cb-green');
    if (safetyBadge && safetyBadge.closest('.card')) {
      const ch = safetyBadge.closest('.card').querySelector('.ch');
      if (ch) {
        const badge = ch.querySelector('.cb');
        if (badge) {
          if (safety_alert === 2) {
            badge.className  = 'cb cb-red';
            badge.textContent= 'CRITICAL';
          } else if (safety_alert === 1) {
            badge.className  = 'cb cb-yellow';
            badge.textContent= 'WARNING';
          } else {
            badge.className  = 'cb cb-green';
            badge.textContent= 'SAFE';
          }
        }
      }
    }

    // ── Imbalance detection ───────────────────────────────────────────────
    if (imbalance_detected) {
      showMLToast(`⚖️ Bed imbalance detected — ${fall_risk_label} fall risk`, 'warn');
    }

    // ── Critical fall risk alert ──────────────────────────────────────────
    if (safety_alert === 2) {
      showMLToast(`🛑 CRITICAL: ${safety_alert_label} — ${(fall_risk_prob*100).toFixed(0)}% fall risk!`, 'crit');
    }

    injectMLRecommendation('safety', { fall_risk_prob, fall_risk_label,
                                       imbalance_detected, safety_alert_label });
  });


  // ══════════════════════════════════════════════════════════════════════════
  // Handler: ml:transfer_assessment
  // Fired after transfer:assess socket event → ML predicts requirements
  // ══════════════════════════════════════════════════════════════════════════
  socket.on('ml:transfer_assessment', (data) => {
    const { patientId, prediction, recommendation } = data;
    if (!prediction) return;

    const {
      risk_level, risk_label, risk_probabilities,
      staff_count, estimated_minutes,
    } = prediction;

    // ── Update risk score display ─────────────────────────────────────────
    const riskBadge = document.querySelector('.cb-yellow');
    if (riskBadge && riskBadge.textContent.includes('RISK')) {
      const colorMap = { 0: 'cb-green', 1: 'cb-yellow', 2: 'cb-red' };
      const labelMap = { 0: 'LOW RISK', 1: 'MEDIUM RISK', 2: 'HIGH RISK' };
      riskBadge.className  = 'cb ' + colorMap[risk_level];
      riskBadge.textContent= labelMap[risk_level];
    }

    // ── Update transfer recommendation box ────────────────────────────────
    const tsBox = document.querySelector('.ts-box');
    if (tsBox) {
      tsBox.className = `ts-box ${risk_level === 2 ? 'crit' : risk_level === 1 ? 'delay' : 'safe'}`;
      const title = tsBox.querySelector('.ts-title');
      const sub   = tsBox.querySelector('.ts-sub');
      const ico   = tsBox.querySelector('.ts-ico');
      if (title) title.textContent = recommendation === 'proceed'
        ? 'Safe to Transfer'
        : recommendation === 'proceed_with_caution'
          ? 'Proceed with Caution'
          : 'Delay Transfer Recommended';
      if (sub) sub.textContent = `ML: ${risk_label} risk · ~${Math.round(estimated_minutes)} min · ${staff_count} staff needed`;
      if (ico) ico.textContent = risk_level === 2 ? '🛑' : risk_level === 1 ? '⏸' : '✅';
    }

    showMLToast(
      `🤖 ML Assessment: ${risk_label} risk · ${staff_count} staff · ${Math.round(estimated_minutes)} min`,
      risk_level === 2 ? 'crit' : risk_level === 1 ? 'warn' : 'ok'
    );
  });


  // ══════════════════════════════════════════════════════════════════════════
  // Handler: alert:new (ML-generated alerts from server)
  // ══════════════════════════════════════════════════════════════════════════
  socket.on('alert:new', (alert) => {
    // Inject into alert list if on alerts page
    const alList = document.querySelector('.al-list');
    if (alList) {
      const severityMap = {
        critical: { cls: 'crit', ico: '🚨', icoCls: 'al-crit-ico' },
        warning:  { cls: 'warn', ico: '⚠️',  icoCls: 'al-warn-ico' },
        info:     { cls: 'info', ico: 'ℹ️',  icoCls: 'al-info-ico' },
      };
      const s = severityMap[alert.severity] || severityMap.info;
      const el = document.createElement('div');
      el.className = `al-item ${s.cls}`;
      el.style.animation = 'slideDown .3s ease';
      el.innerHTML = `
        <div class="al-icon ${s.icoCls}">${s.ico}</div>
        <div style="flex:1;">
          <div class="al-title">🤖 ML Alert: ${alert.type?.replace(/_/g,' ')}</div>
          <div class="al-msg">${alert.message}</div>
          <div class="al-meta">
            <span class="al-time">${new Date(alert.timestamp).toLocaleTimeString()}</span>
            <span class="al-pat">AI-Generated</span>
            <span class="cb cb-${s.cls === 'crit' ? 'red' : s.cls === 'warn' ? 'yellow' : 'blue'}" style="font-size:9px;">ML ALERT</span>
          </div>
        </div>
        <div class="al-actions">
          <button class="al-ack" onclick="this.closest('.al-item').classList.add('acked');this.textContent='✓ Acknowledged'">Acknowledge</button>
          <button class="al-dismiss" onclick="this.closest('.al-item').classList.add('dismissed')">Dismiss</button>
        </div>`;
      alList.prepend(el);
    }

    // Also show notification badge
    const badge = document.getElementById('notifBadge');
    if (badge) badge.style.display = 'block';
  });


  // ══════════════════════════════════════════════════════════════════════════
  // Public: send events to server (called from dashboard buttons/intervals)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Push latest vitals reading for ML analysis.
   * Called from tickLive() or when new sensor data arrives.
   */
  window.mlPushVitals = function ({ patientId, heartRate, spo2, bpSystolic,
                                    age = 60, condition = 0, isPostSurgery = 0 }) {
    socket.emit('vitals:push', { patientId, heartRate, spo2, bpSystolic,
                                 age, condition, isPostSurgery });
  };

  /**
   * Push bed sensor data for safety analysis.
   */
  window.mlPushSafety = function (sensorPayload) {
    socket.emit('safety:push', sensorPayload);
  };

  /**
   * Request ML assessment before a transfer.
   */
  window.mlAssessTransfer = function (transferData) {
    socket.emit('transfer:assess', transferData);
  };


  // ══════════════════════════════════════════════════════════════════════════
  // Internal helpers
  // ══════════════════════════════════════════════════════════════════════════

  function updateVitalsAlertBanner(type, alertClass, alertLabel, value, unit) {
    const bannerEl = document.getElementById(`${type}AlertBanner`);
    const textEl   = document.getElementById(`${type}AlertText`);
    const vcStatus = document.getElementById(`${type}VcStatus`);
    const vCard    = document.getElementById(`${type}VCard`);
    if (!bannerEl) return;

    if (alertClass >= 2) {
      bannerEl.style.display = 'flex';
      bannerEl.className     = 'vitals-alert-banner crit';
      if (textEl) textEl.textContent = `🤖 ML: CRITICAL — ${alertLabel}${value ? ` (${value}${unit})` : ''}`;
      if (vCard)  vCard.className    = 'v-card crit';
      if (vcStatus) { vcStatus.className = 'status-pill sp-crit'; vcStatus.textContent = `🚨 ${alertLabel}`; }
    } else if (alertClass === 1) {
      bannerEl.style.display = 'flex';
      bannerEl.className     = 'vitals-alert-banner warn';
      if (textEl) textEl.textContent = `🤖 ML: ${alertLabel}${value ? ` — ${value}${unit}` : ''}`;
      if (vCard)  vCard.className    = 'v-card warn';
      if (vcStatus) { vcStatus.className = 'status-pill sp-warn'; vcStatus.textContent = `⚠ ${alertLabel}`; }
    } else {
      bannerEl.style.display = 'none';
      if (vCard)  vCard.className = 'v-card';
      if (vcStatus) { vcStatus.className = 'status-pill sp-stable'; vcStatus.textContent = '✓ Normal'; }
    }
  }

  function injectMLRecommendation(source, data) {
    const aiCard = document.querySelector('#page-dashboard .card:last-child .ai-item:last-child');
    if (!aiCard) return;
    const text = aiCard.querySelector('.ai-text');
    const tag  = aiCard.querySelector('.ai-tag');
    if (!text || !tag) return;

    if (source === 'vitals') {
      text.textContent = `ML Vitals: ${data.alert_label} — ${(data.deterioration_prob*100).toFixed(0)}% deterioration risk. `
                       + `Normal: ${(data.probabilities.Normal*100).toFixed(0)}%, `
                       + `Warning: ${(data.probabilities.Warning*100).toFixed(0)}%, `
                       + `Critical: ${(data.probabilities.Critical*100).toFixed(0)}%`;
      tag.textContent = 'ML · LSTM Prediction';
    } else if (source === 'safety') {
      text.textContent = `ML Safety: ${data.safety_alert_label} — Fall risk ${data.fall_risk_label} `
                       + `(${(data.fall_risk_prob*100).toFixed(0)}%). `
                       + (data.imbalance_detected ? 'Bed imbalance detected.' : 'Bed balanced.');
      tag.textContent = 'ML · Safety Model';
    }
  }

  let mlToastTimer;
  const mlToastColors = {
    ok:   'var(--green)',
    warn: 'var(--yellow)',
    crit: 'var(--red)',
  };

  function showMLToast(msg, type = 'ok') {
    // Reuse existing dashboard toast if available
    if (typeof showToast === 'function') {
      showToast(msg);
      return;
    }
    // Fallback: custom ML toast
    let t = document.getElementById('mlToast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'mlToast';
      t.style.cssText = `
        position:fixed;bottom:60px;left:50%;transform:translateX(-50%) translateY(80px);
        background:var(--gray-900);color:white;padding:10px 20px;border-radius:20px;
        font-size:12px;font-weight:600;z-index:998;opacity:0;transition:all .3s;
        pointer-events:none;white-space:nowrap;border-left:4px solid;
      `;
      document.body.appendChild(t);
    }
    t.textContent       = msg;
    t.style.borderColor = mlToastColors[type] || mlToastColors.ok;
    t.style.opacity     = '1';
    t.style.transform   = 'translateX(-50%) translateY(0)';
    clearTimeout(mlToastTimer);
    mlToastTimer = setTimeout(() => {
      t.style.opacity   = '0';
      t.style.transform = 'translateX(-50%) translateY(80px)';
    }, 3000);
  }


  // ══════════════════════════════════════════════════════════════════════════
  // Auto-push: hook into existing tickLive() to send vitals to ML
  // Wraps the existing tickLive function transparently
  // ══════════════════════════════════════════════════════════════════════════
  if (typeof window !== 'undefined') {
    const DEMO_PATIENT_ID = 'PT-2047'; // Rajesh Mehta demo patient

    // Override tickLive to also push to ML after each tick
    const _originalTickLive = window.tickLive;
    if (typeof _originalTickLive === 'function') {
      window.tickLive = function () {
        _originalTickLive();
        // Push current vitals to ML after the tick updates values
        const hr   = parseInt(document.getElementById('hrVal')?.textContent   || '0');
        const spo2 = parseInt(document.getElementById('spo2Val')?.textContent  || '0');
        const bp   = parseInt((document.getElementById('bpVal')?.textContent || '120/80').split('/')[0]);
        if (hr && spo2) {
          window.mlPushVitals({
            patientId:   DEMO_PATIENT_ID,
            heartRate:   hr,
            spo2:        spo2,
            bpSystolic:  bp,
            age:         67,
            condition:   1,  // cardiac
            isPostSurgery: 1,
          });
        }
      };
    }
  }

  console.log('🤖 MedBed ML Socket Client ready');

})();
