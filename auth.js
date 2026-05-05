// ── auth.js — simple agent-based auth ─────────────────────────────────────

const SUPABASE_URL  = 'https://xphtitfasgstjvqkkdvs.supabase.co/rest/v1';
const SUPABASE_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhwaHRpdGZhc2dzdGp2cWtrZHZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MTQzMDQsImV4cCI6MjA5MzQ5MDMwNH0.sjjsfDCeiEWPih2f3eH5rShhvEZZXgS3ApcSy0B0S-M';
const SALT          = 'hd_salt_2026';

window.Auth = (() => {
  let session = null;
  let prefs = null;

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

  // ── Hashing ──────────────────────────────────────────────────────────────

  async function hashPassword(password) {
    const msg = password + SALT;
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
  }

  // ── Session ──────────────────────────────────────────────────────────────

  function getSession() {
    if (session) return session;
    try { session = JSON.parse(localStorage.getItem('hd_agent_session') || 'null'); } catch { session = null; }
    return session;
  }

  function getUser() { return getSession()?.agent || null; }
  function getToken() { return SUPABASE_KEY; }

  function isLoggedIn() {
    const s = getSession();
    if (!s?.agent) return false;
    if (s.expires_at && Date.now() > s.expires_at) { logout(false); return false; }
    return true;
  }

  async function requireAuth() {
    if (!isLoggedIn()) { window.location.replace('/login'); return false; }
    return true;
  }

  function logout(redirect = true) {
    localStorage.removeItem('hd_agent_session');
    session = null; prefs = null;
    if (redirect) window.location.replace('/login');
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  async function login(email, password) {
    const hash = await hashPassword(password);

    const resp = await fetch(
      `${SUPABASE_URL}/agents?email=eq.${encodeURIComponent(email)}&password_hash=eq.${hash}&active=eq.true&select=id,name,email,role,specialties`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );

    const data = await resp.json();
    if (!data || data.length === 0) throw new Error('Invalid email or password');

    const agent = data[0];
    const sessionId = crypto.randomUUID();

    // Record session in DB
    await fetch(`${SUPABASE_URL}/sessions`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        id: sessionId,
        agent_id: agent.id,
        agent_name: agent.name,
        agent_email: agent.email,
        agent_role: agent.role,
        expires_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString()
      })
    });

    // Update last login
    await fetch(`${SUPABASE_URL}/agents?id=eq.${agent.id}`, {
      method: 'PATCH',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ last_login: new Date().toISOString() })
    });

    session = { agent, session_id: sessionId, expires_at: Date.now() + 8 * 3600 * 1000 };
    localStorage.setItem('hd_agent_session', JSON.stringify(session));
    return agent;
  }

  // ── Preferences ──────────────────────────────────────────────────────────

  async function authFetch(path, opts = {}) {
    const resp = await fetch(`${SUPABASE_URL}${path}`, {
      ...opts,
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
    });
    if (resp.status === 204 || resp.headers.get('content-length') === '0') return null;
    const text = await resp.text();
    return text ? JSON.parse(text) : null;
  }

  async function loadPrefs() {
    const agent = getUser();
    if (!agent) return { ...DEFAULT_PREFS };
    try {
      const data = await authFetch(`/user_preferences?id=eq.${agent.id}&select=*`);
      if (data && data.length > 0) {
        prefs = { ...DEFAULT_PREFS, ...data[0] };
      } else {
        prefs = { ...DEFAULT_PREFS, display_name: agent.name };
        await authFetch('/user_preferences', {
          method: 'POST',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({ id: agent.id, ...prefs })
        });
      }
    } catch(e) { prefs = { ...DEFAULT_PREFS }; }
    return prefs;
  }

  async function savePrefs(updates) {
    const agent = getUser();
    if (!agent) return;
    prefs = { ...prefs, ...updates };
    try {
      await authFetch(`/user_preferences?id=eq.${agent.id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates)
      });
    } catch(e) { console.warn('Failed to save prefs:', e); }
    return prefs;
  }

  function getPrefs() { return prefs || { ...DEFAULT_PREFS }; }

  return { getSession, getToken, getUser, isLoggedIn, requireAuth, logout, login, loadPrefs, savePrefs, getPrefs, authFetch, hashPassword };
})();
