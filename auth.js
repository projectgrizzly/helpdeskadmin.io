// ── auth.js — shared auth & preferences module ────────────────────────────

const SUPABASE_AUTH_URL = 'https://xphtitfasgstjvqkkdvs.supabase.co/auth/v1';
const SUPABASE_REST_URL = 'https://xphtitfasgstjvqkkdvs.supabase.co/rest/v1';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhwaHRpdGZhc2dzdGp2cWtrZHZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MTQzMDQsImV4cCI6MjA5MzQ5MDMwNH0.sjjsfDCeiEWPih2f3eH5rShhvEZZXgS3ApcSy0B0S-M';

window.Auth = (() => {
  let session = null;
  let prefs = null;

  // ── Session ──────────────────────────────────────────────────────────────

  function getSession() {
    if (session) return session;
    try { session = JSON.parse(localStorage.getItem('hd_session') || 'null'); } catch { session = null; }
    return session;
  }

  function getToken() {
    const s = getSession();
    return s?.access_token || SUPABASE_ANON_KEY;
  }

  function getUser() {
    return getSession()?.user || null;
  }

  function isLoggedIn() {
    const s = getSession();
    if (!s?.access_token) return false;
    if (s.expires_at && Date.now() > s.expires_at) { logout(false); return false; }
    return true;
  }

  async function requireAuth() {
    if (!isLoggedIn()) {
      window.location.replace('/login');
      return false;
    }
    // Try refresh if expiring soon (< 5 min)
    const s = getSession();
    if (s?.expires_at && Date.now() > s.expires_at - 300000) {
      await refreshToken();
    }
    return true;
  }

  async function refreshToken() {
    const s = getSession();
    if (!s?.refresh_token) return;
    try {
      const resp = await fetch(`${SUPABASE_AUTH_URL}/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: s.refresh_token })
      });
      if (resp.ok) {
        const data = await resp.json();
        session = { access_token: data.access_token, refresh_token: data.refresh_token, user: data.user, expires_at: Date.now() + data.expires_in * 1000 };
        localStorage.setItem('hd_session', JSON.stringify(session));
      }
    } catch(e) { console.warn('Token refresh failed:', e); }
  }

  function logout(redirect = true) {
    localStorage.removeItem('hd_session');
    session = null; prefs = null;
    if (redirect) window.location.replace('/login');
  }

  // ── Preferences ──────────────────────────────────────────────────────────

  const DEFAULT_PREFS = {
    display_name: '',
    widget_layout: ['stat-cards','alert-banner','volume-chart','status-chart','category-chart','agent-table','urgent-table','kb-section'],
    hidden_widgets: [],
    saved_filters: [],
    notify_urgent: true,
    notify_assigned: true,
    notify_resolved: false,
    notify_chat: true
  };

  async function authFetch(path, opts = {}) {
    const resp = await fetch(`${SUPABASE_REST_URL}${path}`, {
      ...opts,
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${getToken()}`,
        'Content-Type': 'application/json',
        ...(opts.headers || {})
      }
    });
    if (resp.status === 204 || resp.headers.get('content-length') === '0') return null;
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }

  async function loadPrefs() {
    if (!isLoggedIn()) return { ...DEFAULT_PREFS };
    const user = getUser();
    try {
      const data = await authFetch(`/user_preferences?id=eq.${user.id}&select=*`);
      if (data && data.length > 0) {
        prefs = { ...DEFAULT_PREFS, ...data[0] };
      } else {
        // Create default prefs for new user
        prefs = { ...DEFAULT_PREFS, id: user.id, display_name: user.email?.split('@')[0] || '' };
        await authFetch('/user_preferences', {
          method: 'POST',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify(prefs)
        });
      }
    } catch(e) {
      console.warn('Failed to load prefs:', e);
      prefs = { ...DEFAULT_PREFS };
    }
    return prefs;
  }

  async function savePrefs(updates) {
    if (!isLoggedIn()) return;
    prefs = { ...prefs, ...updates };
    const user = getUser();
    try {
      await authFetch(`/user_preferences?id=eq.${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates)
      });
    } catch(e) { console.warn('Failed to save prefs:', e); }
    return prefs;
  }

  function getPrefs() { return prefs || { ...DEFAULT_PREFS }; }

  return { getSession, getToken, getUser, isLoggedIn, requireAuth, logout, loadPrefs, savePrefs, getPrefs, authFetch };
})();
