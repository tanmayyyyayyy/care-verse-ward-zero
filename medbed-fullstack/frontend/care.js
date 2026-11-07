/* CareVerse Ward Zero — Care Intelligence, Caregivers & Gateway pages.
   Depends on globals from index.html: apiFetch, switchPage, currentPatient, liveSocket. */
(function () {
  'use strict';

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    role: null,
    overview: [],
    roster: null,
    gateway: null,
    selectedId: null,
    care: null,
    notes: [],
    log: [],
    streamTimer: null,
    busy: false,
    refreshTimer: null,
  };

  const RISK_LABEL = { low: 'Low', medium: 'Medium', high: 'High', unknown: 'Unknown' };
  const PAGES = ['care', 'caregivers'];

  // ── helpers ───────────────────────────────────────────────────────────────
  const post = (path, body) => apiFetch(path, { method: 'POST', body: JSON.stringify(body || {}) });

  const toast = (message, isError) => {
    const el = document.createElement('div');
    el.className = 'wz-toast' + (isError ? ' err' : '');
    el.setAttribute('role', 'status');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3800);
  };

  const fmtMs = (ms) => {
    if (ms == null) return '—';
    if (ms < 1000) return `${ms} ms`;
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const m = Math.floor(s / 60);
    return `${m} min ${s % 60} s`;
  };

  const ago = (iso) => {
    if (!iso) return '—';
    const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  };

  const activePage = () => {
    const el = document.querySelector('.page.active');
    return el ? el.id.replace('page-', '') : '';
  };

  const chip = (cls, text) => `<span class="wz-chip ${esc(cls)}">${esc(text)}</span>`;
  const canControlGateway = () => state.role === 'admin' || state.role === 'doctor';

  const selectedPatient = () => state.overview.find((r) => String(r.patientId) === String(state.selectedId)) || null;

  // ── data loading ──────────────────────────────────────────────────────────
  const loadShared = async () => {
    const [overview, roster, gateway] = await Promise.all([
      apiFetch('/api/care/overview'),
      apiFetch('/api/care/roster'),
      apiFetch('/api/care/gateway'),
    ]);
    state.overview = overview.data || [];
    state.roster = roster.data || null;
    state.gateway = gateway.data || null;
    if (!state.selectedId || !state.overview.some((r) => String(r.patientId) === String(state.selectedId))) {
      const cp = typeof currentPatient !== 'undefined' && currentPatient ? currentPatient.apiId || currentPatient._id : null;
      state.selectedId =
        (cp && state.overview.find((r) => String(r.patientId) === String(cp)) && cp) ||
        (state.overview[0] && state.overview[0].patientId) ||
        null;
    }
  };

  const loadSelected = async () => {
    if (!state.selectedId) {
      state.care = null;
      state.notes = [];
      return;
    }
    const res = await apiFetch(`/api/care/patients/${state.selectedId}/intelligence`);
    state.care = res.data;
    state.notes = res.notes || [];
  };

  const refresh = async () => {
    if (state.busy) {
      state.again = true; // an action finished while a refresh was running: run once more afterwards
      return;
    }
    state.busy = true;
    try {
      if (!state.role) {
        try {
          const me = await apiFetch('/api/auth/me');
          state.role = me.user ? me.user.role : null;
        } catch (e) {
          /* role stays null: gateway controls remain disabled */
        }
      }
      await loadShared();
      await loadSelected();
      renderAll();
    } catch (error) {
      if (activePage() === 'care' || activePage() === 'caregivers') toast(error.message, true);
    } finally {
      state.busy = false;
      if (state.again) {
        state.again = false;
        setTimeout(refresh, 50);
      }
    }
  };

  // ── pipeline strip ────────────────────────────────────────────────────────
  const pipelineHTML = () => {
    const rows = state.overview;
    const total = rows.length;
    const live = rows.filter((r) => r.dataQuality === 'live' || r.dataQuality === 'recent').length;
    const high = rows.filter((r) => r.risk === 'high').length;
    const medium = rows.filter((r) => r.risk === 'medium').length;
    const worsen = rows.filter((r) => r.likelyToWorsen).length;
    const roster = state.roster;
    const gw = state.gateway;
    const metrics = roster ? roster.metrics : null;
    const onDuty = roster ? roster.coverage.onDuty : 0;
    const linkDown = gw && !gw.isOnline;

    const stages = [
      {
        verb: 'Sense',
        val: `${live} of ${total} patients reporting`,
        sub: linkDown ? `Home link down, ${gw.queueLength} readings held` : 'Home link up',
        cls: linkDown ? 'bad' : live < total ? 'warn' : '',
      },
      {
        verb: 'Understand',
        val: `${high} high, ${medium} medium risk`,
        sub: 'Vitals, early-warning score and caregiver notes',
        cls: high ? 'bad' : medium ? 'warn' : '',
      },
      {
        verb: 'Predict',
        val: worsen ? `${worsen} likely to worsen` : 'No worsening trend',
        sub: '24 to 48 h trend projection (experimental)',
        cls: worsen ? 'warn' : '',
      },
      {
        verb: 'Alert',
        val: metrics ? `${metrics.unacknowledged} awaiting acknowledgment` : '—',
        sub: metrics ? `${metrics.escalated} escalated in the last 24 h` : '',
        cls: metrics && metrics.unacknowledged ? 'warn' : '',
      },
      {
        verb: 'Respond',
        val: onDuty ? `${onDuty} caregiver${onDuty > 1 ? 's' : ''} on duty` : 'No caregiver checked in',
        sub: metrics ? `Median response ${fmtMs(metrics.medianResponseMs)}` : '',
        cls: onDuty ? '' : 'bad',
      },
    ];
    return stages
      .map(
        (s) => `<div class="wz-stage ${s.cls}"><div class="verb">${esc(s.verb)}</div><div class="val">${esc(s.val)}</div><div class="sub">${esc(s.sub)}</div></div>`
      )
      .join('');
  };

  const renderPipelines = () => {
    document.querySelectorAll('.wz-pipeline').forEach((el) => {
      el.innerHTML = pipelineHTML();
    });
  };

  // ── Care page ─────────────────────────────────────────────────────────────
  const wardTable = () => {
    if (!state.overview.length) return '<div class="wz-empty">No patients yet.</div>';
    const rows = state.overview
      .map((r) => {
        const sel = String(r.patientId) === String(state.selectedId) ? ' sel' : '';
        const outlook = r.forecastStatus !== 'ok'
          ? '<span class="wz-muted">Needs more data</span>'
          : r.likelyToWorsen
            ? chip('medium', r.hoursToUrgent ? `May worsen in ~${r.hoursToUrgent} h` : 'May worsen')
            : chip('low', 'Steady');
        const dq = r.dataQuality === 'live' || r.dataQuality === 'recent' ? chip('low', 'Live') : chip('unknown', r.dataQuality === 'no_data' ? 'No data' : 'Stale');
        const ctx = r.contextLevel === 'none' ? '<span class="wz-muted">—</span>' : chip(r.contextLevel, r.contextLevel);
        return `<tr class="pick${sel}" tabindex="0" role="button" data-pid="${esc(r.patientId)}" aria-label="Show ${esc(r.name)}">
          <td><div class="name">${esc(r.name)}</div><div class="sub">${esc(r.patientCode)}${r.bed ? ' · ' + esc(r.bed) : ''}</div></td>
          <td>${chip(r.risk, RISK_LABEL[r.risk] || r.risk)}</td>
          <td>${r.earlyWarningScore == null ? '—' : esc(r.earlyWarningScore)}</td>
          <td>${dq}</td><td>${ctx}</td><td>${outlook}</td></tr>`;
      })
      .join('');
    return `<div class="wz-table-wrap"><table class="wz-table"><thead><tr><th>Patient</th><th>Risk now</th><th>Score</th><th>Sensor</th><th>Notes</th><th>Outlook</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  };

  const ewsHTML = (news2, stale) => {
    if (!news2) return '<div class="wz-empty">No reading yet.</div>';
    const rows = news2.breakdown
      .map((b) => {
        const cells = [1, 2, 3].map((n) => `<i class="${b.points >= n ? 'on' + b.points : ''}"></i>`).join('');
        return `<div class="wz-ews-row"><span class="lbl">${esc(b.label)}</span><span class="meter" aria-hidden="true">${cells}</span><span class="num" title="${b.points} point(s)">${esc(b.value)} <span class="wz-muted">+${b.points}</span></span></div>`;
      })
      .join('');
    return `<div class="wz-ews">${rows}<div class="wz-ews-total"><span>${stale ? 'Early-warning score of the last known reading' : 'Early-warning score'}</span><span>${news2.total} (${esc(news2.band)})</span></div></div>`;
  };

  const explainCard = () => {
    const c = state.care;
    if (!c) return '<div class="wz-empty">Select a patient.</div>';
    const reasons = c.reasons.map((r) => `<li>${esc(r)}</li>`).join('');
    const escalated = c.escalatedBy.length ? `<div class="wz-muted" style="margin-bottom:8px">Raised by: ${esc(c.escalatedBy.join(', '))}</div>` : '';
    const factors = c.profileFactors.length ? `<div class="wz-muted" style="margin-top:10px">Patient factors: ${esc(c.profileFactors.join(', '))}. The forecast uses a more sensitive alert threshold (${c.urgentThreshold}).</div>` : '';
    return `
      <div class="wz-risk-head"><span class="wz-risk-badge ${esc(c.risk)}">${esc(RISK_LABEL[c.risk] || c.risk)} risk</span>
        <span class="wz-muted">Sensor: ${esc(c.dataQuality.status)}</span></div>
      ${escalated}
      <ul class="wz-reasons">${reasons}</ul>
      <div class="wz-action ${esc(c.risk)}"><strong>Suggested next step:</strong> ${esc(c.recommendedAction)}</div>
      ${ewsHTML(c.news2, !['live', 'recent'].includes(c.dataQuality.status))}${factors}
      <div class="wz-note">${esc(c.safetyNotice)}</div>`;
  };

  // SVG chart: early-warning score history + 48 h projection
  const chartSVG = (f) => {
    const W = 560, H = 230, L = 34, R = 14, T = 14, B = 34;
    const hist = f.series.history;
    const proj = f.series.projection;
    const xmin = Math.min(-1, ...hist.map((p) => p.t));
    const xmax = 48;
    const ymax = Math.max(10, f.urgentThreshold + 2, ...hist.map((p) => p.score), ...proj.map((p) => p.score)) + 1;
    const X = (t) => L + ((t - xmin) / (xmax - xmin)) * (W - L - R);
    const Y = (s) => T + (1 - s / ymax) * (H - T - B);
    const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.score).toFixed(1)}`).join(' ');
    const histPts = hist.map((p) => ({ t: p.t, score: p.score }));
    const projPts = [{ t: 0, score: hist[hist.length - 1].score }, ...proj.filter((p) => p.t > 0)];
    const grid = [];
    for (let s = 0; s <= ymax; s += 2) grid.push(`<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(s)}" y2="${Y(s)}"/><text x="${L - 6}" y="${Y(s) + 3}" text-anchor="end">${s}</text>`);
    const xt = [[xmin, f.timeAxis === 'simulated' ? `${Math.abs(Math.round(xmin))} h ago (sim)` : `${Math.abs(Math.round(xmin))} h ago`], [0, 'Now'], [24, '+24 h'], [48, '+48 h']]
      .map(([t, label]) => `<text x="${X(t)}" y="${H - 12}" text-anchor="${t === xmin ? 'start' : t === 48 ? 'end' : 'middle'}">${esc(label)}</text>`)
      .join('');
    const markers = f.projections
      .map((p) => `<circle class="ppt" cx="${X(p.hours)}" cy="${Y(p.score)}" r="4.5"><title>${p.hours} h: score ${p.score}</title></circle><text x="${X(p.hours)}" y="${Y(p.score) - 9}" text-anchor="middle" style="font-weight:700;fill:var(--gray-700)">${p.score}</text>`)
      .join('');
    const last = hist[hist.length - 1];
    return `<svg class="wz-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Early-warning score history and 48 hour projection. Current ${last.score}; projected ${f.projections.map((p) => `${p.score} at ${p.hours} hours`).join(', ')}.">
      ${grid.join('')}
      <rect class="zone" x="${X(0)}" y="${T}" width="${X(48) - X(0)}" height="${H - T - B}"/>
      <line class="axis" x1="${L}" x2="${W - R}" y1="${Y(0)}" y2="${Y(0)}"/>
      <line class="thr" x1="${L}" x2="${W - R}" y1="${Y(f.urgentThreshold)}" y2="${Y(f.urgentThreshold)}"/>
      <text class="thr-l" x="${W - R}" y="${Y(f.urgentThreshold) - 5}" text-anchor="end">Urgent review at ${f.urgentThreshold}</text>
      <line class="now" x1="${X(0)}" x2="${X(0)}" y1="${T}" y2="${H - B}"/>
      <path class="hist" d="${path(histPts)}"/>
      <path class="proj" d="${path(projPts)}"/>
      <circle class="pt" cx="${X(0)}" cy="${Y(last.score)}" r="4"/>
      ${markers}${xt}
    </svg>`;
  };

  const forecastCard = () => {
    const c = state.care;
    if (!c) return '<div class="wz-empty">Select a patient.</div>';
    const f = c.forecast;
    if (f.status !== 'ok') {
      return `<div class="wz-verdict">${esc(f.message)}</div><div class="wz-muted">Keep sending readings. The outlook appears once there is enough recent history to show a trend.</div><div class="wz-note">${esc(f.disclaimer)}</div>`;
    }
    const verdictCls = f.deteriorationLikely ? 'warn' : '';
    const horizons = f.projections
      .map((p) => `<div class="wz-horizon"><div class="when">In ${p.hours} hours, if trends continue</div><div class="score">${p.score}<small>${esc(RISK_LABEL[p.band] || p.band)} band</small></div></div>`)
      .join('');
    const drivers = f.drivers.length
      ? f.drivers.map((d) => `<li class="${d.worsening ? 'worse' : ''}">${esc(d.text)} <span class="wz-muted">(fit ${d.r2})</span></li>`).join('')
      : '<li>No vital sign shows a consistent trend.</li>';
    return `
      <div class="wz-verdict ${verdictCls}">${esc(f.message)}</div>
      ${chartSVG(f)}
      <div class="wz-legend"><span>Score so far</span><span class="p">Projection</span><span class="t">Urgent threshold</span></div>
      <div class="wz-horizons">${horizons}</div>
      <div class="wz-h"><h3>What is driving it</h3>${chip(f.confidence === 'moderate' ? 'medium' : 'unknown', 'Confidence: ' + f.confidence)}</div>
      <ul class="wz-drivers">${drivers}</ul>
      <div class="wz-muted" style="margin-top:10px">Based on ${f.readingsUsed} recent readings over ${f.spanHours} h. ${esc(f.timeAxisNote)}</div>
      <div class="wz-note">${esc(f.disclaimer)}</div>`;
  };

  const QUICK_NOTES = [
    'Ate well and feels comfortable.',
    'Felt dizzy after standing up this morning.',
    'Seems confused and drowsy since lunch.',
    'Short of breath when walking to the bathroom.',
    'No chest pain, no dizziness.',
    'Skipped the evening medication.',
  ];

  const notesCard = () => {
    const c = state.care;
    const flags = c && c.context.flags.length
      ? `<div class="wz-row" style="margin:0 0 10px">${c.context.flags.map((f) => chip(f.level, f.label)).join('')}</div><div class="wz-muted" style="margin-bottom:8px">${esc(c.context.summary)}</div>`
      : `<div class="wz-muted" style="margin-bottom:10px">${c ? esc(c.context.summary) : ''}</div>`;
    const list = state.notes.length
      ? state.notes
          .map((n) => {
            const chips = (n.flags || []).map((f) => chip(f.level, f.label)).join('');
            return `<li><div class="meta"><span>${esc(n.authorName || 'Caregiver')}</span><span>${esc(ago(n.createdAt))}</span></div>${esc(n.text)}${chips ? `<div class="flags">${chips}</div>` : ''}</li>`;
          })
          .join('')
      : '<li class="wz-muted">No notes yet.</li>';
    return `
      ${flags}
      <div class="wz-note-form">
        <label for="wzNoteText" class="wz-muted">Caregiver observation</label>
        <textarea id="wzNoteText" maxlength="1000" placeholder="What did you notice? e.g. felt dizzy after breakfast"></textarea>
        <div class="wz-quick">${QUICK_NOTES.map((q) => `<button type="button" data-quick="${esc(q)}">${esc(q)}</button>`).join('')}</div>
        <button class="wz-btn" id="wzAddNote" type="button">Save note</button>
      </div>
      <ul class="wz-notes">${list}</ul>
      <div class="wz-note">Notes can only raise concern, never lower it. Urgent wording (confusion, breathing difficulty, chest pain, fall, bleeding) raises an alert for the responsible clinician.</div>`;
  };

  const careShell = () => `
    <div class="wz-pipeline" role="status" aria-live="polite"></div>
    <div class="wz-card" style="margin-bottom:16px"><div class="wz-h"><h3>Everyone in the home care ward</h3><small>Select a patient to see why</small></div><div id="wzWard"></div></div>
    <div class="wz-grid two">
      <div class="wz-stack">
        <div class="wz-card"><div class="wz-h"><h3 id="wzWho">Why this risk</h3></div><div id="wzExplain"></div></div>
        <div class="wz-card"><div class="wz-h"><h3>Caregiver notes and context</h3></div><div id="wzNotes"></div></div>
      </div>
      <div class="wz-card"><div class="wz-h"><h3>Outlook for the next 24 to 48 hours</h3><small>Experimental</small></div><div id="wzForecast"></div></div>
    </div>`;

  const renderCare = () => {
    const root = document.getElementById('page-care');
    if (!root) return;
    if (!root.dataset.ready) {
      root.innerHTML = careShell();
      root.dataset.ready = '1';
      root.addEventListener('click', onCareClick);
      root.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('tr.pick')) {
          e.preventDefault();
          onCareClick(e);
        }
      });
    }
    const keepNote = document.getElementById('wzNoteText');
    const draft = keepNote ? keepNote.value : '';
    const hadFocus = keepNote && document.activeElement === keepNote;
    document.getElementById('wzWard').innerHTML = wardTable();
    const sel = selectedPatient();
    document.getElementById('wzWho').textContent = sel ? `Why ${sel.name} is rated this way` : 'Why this risk';
    document.getElementById('wzExplain').innerHTML = explainCard();
    document.getElementById('wzForecast').innerHTML = forecastCard();
    document.getElementById('wzNotes').innerHTML = notesCard();
    const ta = document.getElementById('wzNoteText');
    if (ta && draft) ta.value = draft;
    if (ta && hadFocus) ta.focus();
  };

  async function onCareClick(e) {
    const row = e.target.closest('tr.pick');
    if (row) {
      state.selectedId = row.dataset.pid;
      try {
        await loadSelected();
      } catch (err) {
        toast(err.message, true);
      }
      renderCare();
      return;
    }
    const quick = e.target.closest('[data-quick]');
    if (quick) {
      const ta = document.getElementById('wzNoteText');
      ta.value = quick.dataset.quick;
      ta.focus();
      return;
    }
    if (e.target.closest('#wzAddNote')) {
      const ta = document.getElementById('wzNoteText');
      const text = ta.value.trim();
      if (text.length < 3) return toast('Please write at least a few words.', true);
      const btn = e.target.closest('#wzAddNote');
      btn.disabled = true;
      try {
        const res = await post(`/api/care/patients/${state.selectedId}/notes`, { text });
        ta.value = '';
        toast(res.alertsCreated ? 'Note saved. An alert was raised for the care team.' : 'Note saved.');
        await refresh();
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    }
  }

  // ── Caregivers & gateway page ─────────────────────────────────────────────
  const rosterTable = () => {
    const r = state.roster;
    if (!r) return '<div class="wz-empty">Loading…</div>';
    const rows = r.caregivers
      .map((c) => {
        const label = { active: 'Active', idle: 'Idle', unresponsive: 'Not responding', off_duty: 'Off duty' }[c.presence] || c.presence;
        return `<tr><td><div class="name">${esc(c.name)}</div><div class="sub">${esc(c.role)}${c.department ? ' · ' + esc(c.department) : ''}</div></td>
          <td>${chip(c.presence, label)}</td>
          <td>${c.onDuty ? esc(ago(c.checkInAt)) : '—'}</td>
          <td>${c.onDuty ? esc(ago(c.lastActivityAt)) : '—'}</td>
          <td>${c.activity.acknowledged} / ${c.activity.notes}</td>
          <td>${esc(fmtMs(c.medianResponseMs))}</td></tr>`;
      })
      .join('');
    return `<div class="wz-table-wrap"><table class="wz-table"><thead><tr><th>Caregiver</th><th>Status</th><th>Checked in</th><th>Last activity</th><th>Acks / notes</th><th>Median response</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  };

  const coverageCard = () => {
    const r = state.roster;
    if (!r) return '';
    const m = r.metrics;
    const cov = r.coverage;
    return `
      <div class="wz-kpis">
        <div class="wz-kpi ${cov.covered ? 'good' : 'bad'}"><div class="n">${cov.onDuty}</div><div class="l">On duty now</div></div>
        <div class="wz-kpi"><div class="n">${m.acknowledged}</div><div class="l">Alerts acknowledged (24 h)</div></div>
        <div class="wz-kpi ${m.unacknowledged ? 'bad' : ''}"><div class="n">${m.unacknowledged}</div><div class="l">Waiting for a response</div></div>
        <div class="wz-kpi"><div class="n">${esc(fmtMs(m.medianResponseMs))}</div><div class="l">Median response</div></div>
        <div class="wz-kpi"><div class="n">${esc(fmtMs(m.p90ResponseMs))}</div><div class="l">Slowest 10% under</div></div>
      </div>
      <p class="wz-muted" style="margin:12px 0 10px">${esc(cov.note)} Caregivers count as idle after ${r.thresholds.idleMinutes} min and not responding after ${r.thresholds.unresponsiveMinutes} min without activity.</p>
      <div class="wz-row">
        <button class="wz-btn ok" id="wzCheckIn" type="button">Check in</button>
        <button class="wz-btn ghost" id="wzCheckOut" type="button">Check out</button>
      </div>`;
  };

  const gatewayCard = () => {
    const g = state.gateway;
    if (!g) return '<div class="wz-empty">Loading…</div>';
    const up = g.isOnline;
    const allowed = canControlGateway();
    const patients = state.overview.map((r) => `<option value="${esc(r.patientId)}" ${String(r.patientId) === String(state.selectedId) ? 'selected' : ''}>${esc(r.name)} (${esc(r.patientCode)})</option>`).join('');
    const lastReplay = g.lastReplayCount ? `Last reconnect replayed ${g.lastReplayCount} reading${g.lastReplayCount > 1 ? 's' : ''} in order.` : 'No outage yet.';
    const streaming = Boolean(state.streamTimer);
    return `
      <div class="wz-link ${up ? 'up' : 'down'}" role="status">
        <span class="led"></span>
        <div style="flex:1"><div class="t">${up ? 'Bedroom sensors connected' : 'Connection lost. Readings are being held safely'}</div>
          <div class="s">${up ? esc(lastReplay) : `${g.queueLength} reading${g.queueLength === 1 ? '' : 's'} queued on the home hub. Nothing is lost; they replay in order on reconnect.`}</div></div>
        <button class="wz-btn ${up ? 'danger' : 'ok'}" id="wzLink" type="button" ${allowed ? '' : 'disabled title="Doctor or admin only"'}>${up ? 'Cut the link' : 'Reconnect and replay'}</button>
      </div>
      <div class="wz-kpis" style="margin-bottom:12px">
        <div class="wz-kpi ${g.queueLength ? 'bad' : ''}"><div class="n">${g.queueLength}</div><div class="l">Queued</div></div>
        <div class="wz-kpi"><div class="n">${g.deadLetterCount ?? 0}</div><div class="l">Rejected (dead letter)</div></div>
        <div class="wz-kpi"><div class="n">${g.lastReplayCount || 0}</div><div class="l">Last replay</div></div>
      </div>
      <div class="wz-row">
        <select class="wz-select" id="wzDevPatient" aria-label="Patient">${patients}</select>
        <select class="wz-select" id="wzDevScenario" aria-label="Scenario">
          <option value="stable">Stable</option><option value="slow_decline" selected>Slow decline</option><option value="sudden_drop">Sudden drop</option></select>
        <button class="wz-btn ghost" id="wzSend" type="button" ${allowed ? '' : 'disabled'}>Send one reading</button>
        <button class="wz-btn ${streaming ? 'danger' : ''}" id="wzStream" type="button" ${allowed ? '' : 'disabled'}>${streaming ? 'Stop sensor stream' : 'Start sensor stream'}</button>
      </div>
      <ul class="wz-log" aria-live="polite">${state.log.map((l) => `<li class="${l.queued ? 'q' : ''}">${esc(l.text)}</li>`).join('') || '<li>Synthetic device log appears here.</li>'}</ul>
      <div class="wz-note">The simulator is a synthetic bedroom device. Each reading goes through the same gateway, validation, AI assessment, forecast and alerting path a real sensor would use.</div>`;
  };

  const ladderCard = () => `
    <ul class="wz-ladder">
      <li><b>First</b><span>The assigned clinician is notified the moment an alert is raised.</span></li>
      <li><b>If unanswered</b><span>The alert escalates to the wider clinical team, then to an administrator, each step after a wait.</span></li>
      <li><b>No one on duty</b><span>If nobody is checked in while alerts wait, a single critical escalation goes to the care coordinator.</span></li>
      <li><b>Always</b><span>Every acknowledgment is timed and written to the audit log.</span></li>
    </ul>`;

  const caregiversShell = () => `
    <div class="wz-pipeline" role="status" aria-live="polite"></div>
    <div class="wz-grid even">
      <div class="wz-stack">
        <div class="wz-card"><div class="wz-h"><h3>Caregiver coverage and response</h3></div><div id="wzCoverage"></div></div>
        <div class="wz-card"><div class="wz-h"><h3>Who is responding</h3></div><div id="wzRoster"></div></div>
        <div class="wz-card"><div class="wz-h"><h3>How escalation works</h3></div>${ladderCard()}</div>
      </div>
      <div class="wz-card"><div class="wz-h"><h3>Home hub and sensor link</h3><small>Resilience demo</small></div><div id="wzGateway"></div></div>
    </div>`;

  const renderCaregivers = () => {
    const root = document.getElementById('page-caregivers');
    if (!root) return;
    if (!root.dataset.ready) {
      root.innerHTML = caregiversShell();
      root.dataset.ready = '1';
      root.addEventListener('click', onCaregiverClick);
    }
    const devP = document.getElementById('wzDevPatient');
    const devS = document.getElementById('wzDevScenario');
    const keepP = devP ? devP.value : null;
    const keepS = devS ? devS.value : null;
    document.getElementById('wzCoverage').innerHTML = coverageCard();
    document.getElementById('wzRoster').innerHTML = rosterTable();
    document.getElementById('wzGateway').innerHTML = gatewayCard();
    if (keepP) document.getElementById('wzDevPatient').value = keepP;
    if (keepS) document.getElementById('wzDevScenario').value = keepS;
  };

  const logReading = (r) => {
    state.log.unshift({
      queued: r.queued,
      text: `${new Date().toLocaleTimeString()}  HR ${r.heartRate}  SpO₂ ${r.spo2}  BP ${r.bpSystolic}  RR ${r.respiratoryRate}  ${r.queued ? 'held on hub' : 'delivered'}`,
    });
    state.log = state.log.slice(0, 40);
  };

  const sendReading = async () => {
    const patientId = document.getElementById('wzDevPatient').value;
    const scenario = document.getElementById('wzDevScenario').value;
    const res = await post('/api/care/gateway/emit', { patientId, scenario, steps: 1 });
    res.submitted.forEach(logReading);
    state.gateway = res.status;
    if (String(patientId) !== String(state.selectedId)) state.selectedId = patientId;
    scheduleRefresh(400);
  };

  const stopStream = () => {
    if (state.streamTimer) clearInterval(state.streamTimer);
    state.streamTimer = null;
  };

  async function onCaregiverClick(e) {
    const id = (e.target.closest('button') || {}).id;
    if (!id) return;
    try {
      if (id === 'wzCheckIn') {
        const r = await post('/api/care/check-in', {});
        toast(r.created ? 'You are checked in.' : 'You were already checked in.');
        await refresh();
      } else if (id === 'wzCheckOut') {
        await post('/api/care/check-out', {});
        toast('You are checked out.');
        await refresh();
      } else if (id === 'wzLink') {
        const goOnline = !(state.gateway && state.gateway.isOnline);
        const r = await post('/api/care/gateway/connectivity', { online: goOnline });
        state.gateway = r.data;
        toast(goOnline ? `Reconnected. ${r.data.lastReplayCount || 0} held readings replayed.` : 'Link cut. New readings will be held on the hub.');
        await refresh();
      } else if (id === 'wzSend') {
        await sendReading();
      } else if (id === 'wzStream') {
        if (state.streamTimer) {
          stopStream();
          renderCaregivers();
        } else {
          await sendReading();
          state.streamTimer = setInterval(() => sendReading().catch((err) => { stopStream(); toast(err.message, true); }), 3000);
          renderCaregivers();
        }
      }
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ── orchestration ─────────────────────────────────────────────────────────
  const renderAll = () => {
    renderPipelines();
    renderCare();
    renderCaregivers();
  };

  const scheduleRefresh = (delay = 300) => {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(refresh, delay);
  };

  const hookSocket = () => {
    if (hookSocket.done) return true;
    const sock = typeof liveSocket !== 'undefined' ? liveSocket : window.medbedSocket;
    if (!sock) return false;
    sock.on('care:update', (payload) => {
      if (payload && String(payload.patientId) === String(state.selectedId)) {
        state.care = payload.care;
        if (PAGES.includes(activePage())) renderCare();
      }
      if (PAGES.includes(activePage()) || activePage() === 'dashboard') scheduleRefresh(800);
    });
    sock.on('gateway:status', (status) => {
      state.gateway = status;
      renderPipelines();
      if (activePage() === 'caregivers') renderCaregivers();
    });
    sock.on('caregiver:presence', () => scheduleRefresh(300));
    ['alert:new', 'alert:resolved', 'alert:acknowledged'].forEach((evt) => sock.on(evt, () => scheduleRefresh(800)));
    hookSocket.done = true;
    return true;
  };

  const install = () => {
    // Dashboard: pipeline strip above the existing grid
    const dash = document.getElementById('page-dashboard');
    if (dash && !dash.querySelector('.wz-dash-strip')) {
      const strip = document.createElement('div');
      strip.className = 'wz-dash-strip';
      strip.innerHTML = '<div class="wz-pipeline" role="status" aria-live="polite"></div>';
      dash.insertBefore(strip, dash.firstChild);
    }

    const baseSwitch = window.switchPage;
    window.switchPage = function (page) {
      baseSwitch(page);
      const labels = { care: 'Home Care Intelligence', caregivers: 'Caregivers and Home Hub' };
      if (labels[page]) {
        const crumb = document.getElementById('pageCrumb');
        if (crumb) crumb.textContent = labels[page];
      }
      if (PAGES.includes(page) || page === 'dashboard') {
        hookSocket();
        refresh();
      }
    };

    window.addEventListener('beforeunload', stopStream);
    setInterval(() => {
      if (!document.hidden && (PAGES.includes(activePage()) || activePage() === 'dashboard')) {
        hookSocket();
        refresh();
      }
    }, 10000);

    // first load (dashboard is the landing page)
    const waitHook = setInterval(() => {
      if (hookSocket()) clearInterval(waitHook);
    }, 1000);
    setTimeout(() => clearInterval(waitHook), 60000);
    refresh();
  };

  window.WardZero = { refresh, state };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install);
  else install();
})();
