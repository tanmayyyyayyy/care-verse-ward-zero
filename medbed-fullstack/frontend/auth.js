// frontend/auth.js
// ─────────────────────────────────────────────────────────────────────────────
// Drop this script into the existing dashboard (index.html) with ONE line:
//   <script src="auth.js"></script>   (before </body>)
//
// It will:
//   1. Guard the page — redirect to login if no token
//   2. Inject a user info chip + logout button into the topbar
//   3. Expose window.medbedAPI for making authenticated fetch() calls
//   4. Initialise a Socket.IO connection with the JWT token
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const API_BASE   = '/api';
  const TOKEN_KEY  = 'medbed_token';
  const USER_KEY   = 'medbed_user';

  // ── 1. Auth guard ──────────────────────────────────────────────────────────
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    window.location.href = 'login.html';
    return; // Stop execution immediately
  }

  const user = JSON.parse(localStorage.getItem(USER_KEY) || '{}');

  // ── 2. Verify token with backend on load (catches expired tokens) ──────────
  async function verifyToken() {
    try {
      const res = await fetch(`${API_BASE}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Invalid token');
      const data = await res.json();
      // Refresh stored user in case of role/name update
      localStorage.setItem(USER_KEY, JSON.stringify(data.user));
    } catch {
      logout(true); // Silent logout + redirect
    }
  }
  verifyToken();

  // ── 3. Logout ──────────────────────────────────────────────────────────────
  function logout(silent = false) {
    // Notify backend (fire-and-forget, no await needed)
    if (!silent) {
      fetch(`${API_BASE}/auth/logout`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.href = 'login.html';
  }
  window.medbedLogout = logout; // expose globally so existing code can call it

  // ── 4. Inject user info + logout into topbar ───────────────────────────────
  // We wait for DOM to be ready, then append after the existing avatar element.
  function injectAuthUI() {
    const topbar = document.querySelector('.topbar');
    if (!topbar) return; // Dashboard not yet loaded

    // Build role badge colour
    const roleColors = {
      admin:  { bg: '#EDE9FE', color: '#7C3AED' },
      doctor: { bg: '#DBEAFE', color: '#1D4ED8' },
      nurse:  { bg: '#D1FAE5', color: '#065F46' },
    };
    const rc = roleColors[user.role] || roleColors.nurse;

    // Build the auth strip HTML
    const strip = document.createElement('div');
    strip.id = 'authStrip';
    strip.style.cssText = `
      display:flex; align-items:center; gap:10px;
      margin-left:8px; padding-left:12px;
      border-left:1px solid #E2E8F0;
    `;
    strip.innerHTML = `
      <div style="text-align:right;">
        <div style="font-size:12px;font-weight:700;color:#0F172A;">${user.name || 'User'}</div>
        <div style="display:flex;align-items:center;gap:4px;justify-content:flex-end;margin-top:1px;">
          <span style="background:${rc.bg};color:${rc.color};font-size:9px;font-weight:700;padding:1px 7px;border-radius:20px;letter-spacing:.4px;text-transform:uppercase;">${user.role || 'nurse'}</span>
        </div>
      </div>
      <button
        onclick="window.medbedLogout()"
        title="Sign out"
        style="
          width:32px;height:32px;border-radius:8px;
          background:#FEF2F2;border:1px solid rgba(239,68,68,.2);
          cursor:pointer;display:flex;align-items:center;justify-content:center;
          transition:background .15s;flex-shrink:0;
        "
        onmouseover="this.style.background='#EF4444'"
        onmouseout="this.style.background='#FEF2F2'"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="#EF4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
          onmouseover="this.style.stroke='white'" onmouseout="this.style.stroke='#EF4444'">
          <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/>
          <polyline points="16 17 21 12 16 7"/>
          <line x1="21" y1="12" x2="9" y2="12"/>
        </svg>
      </button>
    `;

    // Override the existing avatar element's onclick (profile dropdown stays)
    // We insert the strip AFTER the last child of .t-actions
    const tActions = topbar.querySelector('.t-actions');
    if (tActions) {
      tActions.appendChild(strip);
    } else {
      topbar.appendChild(strip);
    }

    // Also override the existing "Sign Out" menu item in the profile dropdown
    // to use our logout function instead of just showing a toast
    const profSignOut = document.querySelector('.prof-menu-item.danger');
    if (profSignOut) {
      profSignOut.onclick = () => logout();
    }

    // Replace the generic avatar initials with the real user initials
    const avatar = document.getElementById('profBtn');
    if (avatar && user.name) {
      const initials = user.name.split(' ').slice(0, 2).map(w => w[0].toUpperCase()).join('');
      avatar.textContent = initials;
    }
  }

  // Run after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectAuthUI);
  } else {
    injectAuthUI();
  }

  // ── 5. Global authenticated fetch wrapper ──────────────────────────────────
  // Usage anywhere in the dashboard JS:
  //   const data = await window.medbedAPI.get('/patients');
  //   const result = await window.medbedAPI.post('/transfers', payload);

  window.medbedAPI = {
    _headers() {
      return {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${localStorage.getItem(TOKEN_KEY)}`,
      };
    },

    async get(path) {
      const res  = await fetch(`${API_BASE}${path}`, { headers: this._headers() });
      const data = await res.json();
      if (res.status === 401) { logout(true); return null; }
      return data;
    },

    async post(path, body) {
      const res  = await fetch(`${API_BASE}${path}`, {
        method:  'POST',
        headers: this._headers(),
        body:    JSON.stringify(body),
      });
      const data = await res.json();
      if (res.status === 401) { logout(true); return null; }
      return data;
    },

    async patch(path, body) {
      const res  = await fetch(`${API_BASE}${path}`, {
        method:  'PATCH',
        headers: this._headers(),
        body:    JSON.stringify(body),
      });
      const data = await res.json();
      if (res.status === 401) { logout(true); return null; }
      return data;
    },

    async delete(path) {
      const res  = await fetch(`${API_BASE}${path}`, {
        method:  'DELETE',
        headers: this._headers(),
      });
      const data = await res.json();
      if (res.status === 401) { logout(true); return null; }
      return data;
    },
  };

  // ── 6. Socket.IO authenticated connection ──────────────────────────────────
  // Only initialise if socket.io client script is present on the page
  if (typeof io !== 'undefined') {
    const socket = io({
      auth: { token },
      reconnectionAttempts: 5,
      reconnectionDelay: 2000,
    });

    socket.on('connect', () => {
      console.log('🔌 Socket connected with auth:', socket.id);
    });

    socket.on('connect_error', (err) => {
      console.warn('Socket connection error:', err.message);
    });

    // Expose socket globally for use in dashboard JS
    window.medbedSocket = socket;
  }

  // ── 7. Role-based UI gating ────────────────────────────────────────────────
  // Add data-role attributes to HTML elements you want to show/hide by role.
  // Example: <button data-role="admin,doctor">Approve</button>
  function applyRoleGating() {
    document.querySelectorAll('[data-role]').forEach((el) => {
      const allowedRoles = el.getAttribute('data-role').split(',').map(r => r.trim());
      if (!allowedRoles.includes(user.role)) {
        el.style.display = 'none';
        el.setAttribute('aria-hidden', 'true');
      }
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyRoleGating);
  } else {
    applyRoleGating();
  }

})();
