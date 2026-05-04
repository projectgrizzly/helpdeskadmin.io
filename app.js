// ── Config ─────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://xphtitfasgstjvqkkdvs.supabase.co/rest/v1';

const PRIORITY_ORDER = { Urgent: 0, High: 1, Medium: 2, Low: 3 };

let tickets = [];
let selectedId = null;
let currentView = 'all';
let aiCache = {};
let apiKey = localStorage.getItem('hd_api_key') || '';
let supabaseKey = localStorage.getItem('hd_supabase_key') || '';

// ── Supabase Helpers ───────────────────────────────────────────────────────

function sbHeaders() {
  return {
    'apikey': supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json'
  };
}

async function sbFetch(path, options = {}) {
  if (!supabaseKey) throw new Error('No Supabase key configured');
  const resp = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: { ...sbHeaders(), ...(options.headers || {}) }
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.message || err.hint || `HTTP ${resp.status}`);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

async function loadTickets() {
  showListLoading(true);
  try {
    const data = await sbFetch('/tickets?select=*&order=created.desc');
    tickets = data || [];
    filterTickets();
  } catch (e) {
    showListError(e.message);
  } finally {
    showListLoading(false);
  }
}

async function insertTicket(t) {
  const data = await sbFetch('/tickets?select=*', {
    method: 'POST',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify(t)
  });
  return Array.isArray(data) ? data[0] : data;
}

async function patchTicket(id, changes) {
  await sbFetch(`/tickets?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(changes)
  });
}

// ── Init ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('search').addEventListener('input', filterTickets);
  document.getElementById('sort-sel').addEventListener('change', filterTickets);

  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', e => {
      e.preventDefault();
      setView(el.dataset.view);
    });
  });

  updateSyncStatus();

  if (supabaseKey) {
    loadEmployees().then(() => loadTickets());
  } else {
    showListError('Enter your Supabase anon key to load tickets.');
    filterTickets();
  }
});

function updateSyncStatus() {
  const dot = document.getElementById('sync-dot');
  const label = document.getElementById('sync-label');
  if (supabaseKey && apiKey) {
    dot.style.background = 'var(--green)';
    label.textContent = 'Fully Connected';
    label.style.color = 'var(--green)';
    dot.style.animation = 'pulse 2s infinite';
  } else if (supabaseKey) {
    dot.style.background = 'var(--blue)';
    label.textContent = 'DB Connected';
    label.style.color = 'var(--blue)';
    dot.style.animation = 'none';
  } else {
    dot.style.background = 'var(--amber)';
    label.textContent = 'Not configured';
    label.style.color = 'var(--amber)';
    dot.style.animation = 'none';
  }
}

// ── Navigation ─────────────────────────────────────────────────────────────

function setView(v) {
  currentView = v;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active', el.dataset.view === v);
  });
  filterTickets();
}

// ── Filtering & Rendering ──────────────────────────────────────────────────

function filterTickets() {
  const q = document.getElementById('search').value.toLowerCase();
  const sort = document.getElementById('sort-sel').value;

  let list = tickets.filter(t => {
    if (currentView === 'open')     return t.status === 'open';
    if (currentView === 'progress') return t.status === 'progress';
    if (currentView === 'resolved') return t.status === 'resolved' || t.status === 'closed';
    if (currentView === 'urgent')   return t.priority === 'Urgent';
    return true;
  }).filter(t =>
    !q ||
    (t.title || '').toLowerCase().includes(q) ||
    (t.requester || '').toLowerCase().includes(q) ||
    (t.category || '').toLowerCase().includes(q) ||
    (t.id || '').toLowerCase().includes(q)
  );

  if (sort === 'priority') list.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9));
  else if (sort === 'status') list.sort((a, b) => (a.status || '').localeCompare(b.status || ''));
  else list.sort((a, b) => (b.created || '').localeCompare(a.created || ''));

  renderList(list);
  updateBadges();
}

function updateBadges() {
  document.getElementById('badge-all').textContent    = tickets.length;
  document.getElementById('badge-open').textContent   = tickets.filter(t => t.status === 'open').length;
  document.getElementById('badge-urgent').textContent = tickets.filter(t => t.priority === 'Urgent').length;
}

function statusLabel(s) {
  return s === 'progress' ? 'In Progress' : (s || '').charAt(0).toUpperCase() + (s || '').slice(1);
}

function showListLoading(on) {
  if (on) {
    document.getElementById('ticket-list').innerHTML =
      `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px;display:flex;align-items:center;justify-content:center;gap:10px"><div class="spinner"></div> Loading tickets…</div>`;
  }
}

function showListError(msg) {
  document.getElementById('ticket-list').innerHTML = `<div style="padding:24px 16px"><div class="api-notice">${escHtml(msg)}</div></div>`;
}

function renderList(list) {
  const el = document.getElementById('ticket-list');
  if (!list.length) {
    el.innerHTML = `<div style="padding:40px 20px;text-align:center;color:var(--text-3);font-size:13px">No tickets match this view</div>`;
    return;
  }
  el.innerHTML = list.map(t => `
    <div class="ticket-item${selectedId === t.id ? ' selected' : ''}" onclick="selectTicket('${escHtml(t.id)}')">
      <div class="ti-id">${escHtml(t.id)} · ${escHtml(t.category || '')}</div>
      <div class="ti-title">${escHtml(t.title || '')}</div>
      <div class="ti-meta">
        <span class="pill pill-${(t.priority || 'low').toLowerCase()}">${escHtml(t.priority || '')}</span>
        <span class="pill pill-${t.status || 'open'}">${statusLabel(t.status)}</span>
        <span class="ti-requester">${escHtml(t.requester || '')}</span>
      </div>
    </div>
  `).join('');
}

// ── Ticket Detail ──────────────────────────────────────────────────────────

function selectTicket(id) {
  selectedId = id;
  filterTickets();
  const t = tickets.find(x => x.id === id);
  if (!t) return;

  const configNotice = (!apiKey || !supabaseKey) ? `
    <div class="api-notice">
      <strong>Setup required</strong>
      ${!supabaseKey ? `<div style="margin-top:8px">Supabase anon key missing — changes won't persist.<div class="api-key-field"><input type="password" id="sb-key-input" placeholder="eyJ…"><button onclick="saveSupabaseKey()">Save DB key</button></div></div>` : ''}
      ${!apiKey ? `<div style="margin-top:8px">Anthropic key missing — AI features disabled.<div class="api-key-field"><input type="password" id="api-key-input" placeholder="sk-ant-…"><button onclick="saveApiKey()">Save AI key</button></div></div>` : ''}
    </div>
  ` : '';

  document.getElementById('detail-pane').innerHTML = `
    <div class="detail-head">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div>
          <div class="detail-id">${escHtml(t.id)} &middot; ${escHtml(t.category || '')} &middot; ${escHtml(t.created || '')}</div>
          <div class="detail-title">${escHtml(t.title || '')}</div>
          <div class="detail-tags">
            <span class="pill pill-${(t.priority || 'low').toLowerCase()}">${escHtml(t.priority || '')}</span>
            <span class="pill pill-${t.status || 'open'}">${statusLabel(t.status)}</span>
            ${t.assigned ? `<span class="pill pill-closed">Assigned: ${escHtml(t.assigned)}</span>` : ''}
          </div>
        </div>
        <button class="emp-btn danger" style="flex-shrink:0;margin-top:4px" onclick="deleteTicket('${escHtml(t.id)}')">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:4px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          Delete
        </button>
      </div>
    </div>

    ${configNotice}

    <div class="meta-grid">
      <div class="meta-card">
        <label>Requester</label>
        <div class="meta-val">${escHtml(t.requester || '—')}</div>
      </div>
      <div class="meta-card">
        <label>Status</label>
        <select onchange="changeStatus('${escHtml(t.id)}', this.value)">
          ${['open','progress','resolved','closed'].map(s =>
            `<option value="${s}"${t.status === s ? ' selected' : ''}>${statusLabel(s)}</option>`
          ).join('')}
        </select>
      </div>
      <div class="meta-card">
        <label>Assigned To</label>
        ${populateReassignSelect(t.id, t.assigned || '')}
      </div>
    </div>

    <div class="section-label">Description</div>
    <div class="description-box">${escHtml(t.description || 'No description provided.')}</div>

    <div class="ai-section">
      <div class="ai-header">
        <div class="ai-title"><div class="ai-star">★</div> AI Analysis</div>
      </div>
      <div class="ai-content" id="ai-content-${escHtml(t.id)}">
        <div class="ai-loading"><div class="spinner"></div> Analyzing ticket…</div>
      </div>
    </div>

    <div class="reply-area">
      <div class="section-label" style="margin-bottom:10px">Reply / Internal Note</div>
      <textarea id="reply-${escHtml(t.id)}" placeholder="Type your reply or leave an internal note…"></textarea>
      <div class="reply-actions">
        <button class="btn-ai" onclick="suggestReply('${escHtml(t.id)}')">★ Suggest reply</button>
        <button class="btn-note" onclick="addNote('${escHtml(t.id)}')">Add note</button>
        <button class="btn-send" onclick="sendReply('${escHtml(t.id)}')">Send reply</button>
      </div>
    </div>
  `;

  analyzeTicket(t);
}

// ── AI Functions ───────────────────────────────────────────────────────────

async function analyzeTicket(t) {
  const cacheKey = t.id + ':' + t.status;
  if (aiCache[cacheKey]) { setAiContent(t.id, aiCache[cacheKey]); return; }

  if (!apiKey) {
    setAiContent(t.id, `<span style="color:var(--text-3);font-size:13px">Enter an Anthropic API key to enable AI analysis.</span>`);
    return;
  }

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system: 'You are a help desk AI assistant. Analyze support tickets concisely. Respond only in valid JSON with no markdown or extra text.',
        messages: [{
          role: 'user',
          content: `Analyze this help desk ticket. Respond with exactly this JSON structure:
{"summary":"one sentence summary","root_cause":"likely cause in 1-2 sentences","steps":["step1","step2","step3"],"urgency_note":"time-sensitive note or empty string"}

Ticket: ${JSON.stringify({ id: t.id, title: t.title, description: t.description, priority: t.priority, status: t.status, category: t.category })}`
        }]
      })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error?.message || `HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const raw = data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());

    const html = `
      <div class="ai-row"><strong>Summary:</strong> ${escHtml(parsed.summary)}</div>
      <div class="ai-row"><strong>Likely cause:</strong> ${escHtml(parsed.root_cause)}</div>
      <div class="ai-row">
        <strong>Recommended steps:</strong>
        <ol class="ai-steps">
          ${parsed.steps.map((s, i) => `<li><span class="step-num">${i + 1}</span>${escHtml(s)}</li>`).join('')}
        </ol>
      </div>
      ${parsed.urgency_note ? `<div class="ai-urgency">⚠ ${escHtml(parsed.urgency_note)}</div>` : ''}
    `;

    aiCache[cacheKey] = html;
    setAiContent(t.id, html);
  } catch (e) {
    setAiContent(t.id, `<span style="color:var(--red);font-size:13px">AI error: ${escHtml(e.message)}</span>`);
  }
}

async function suggestReply(id) {
  const t = tickets.find(x => x.id === id);
  if (!t) return;
  const ta = document.getElementById('reply-' + id);
  if (!apiKey) { ta.value = 'Please add your Anthropic API key to use AI reply suggestions.'; return; }

  ta.value = 'Generating reply…';
  ta.disabled = true;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1000,
        system: 'You are a professional, empathetic help desk agent. Write clear, concise support replies. No subject line, no preamble, just the reply body.',
        messages: [{
          role: 'user',
          content: `Write a professional help desk reply for this ticket.\n\nTitle: ${t.title}\nDescription: ${t.description}\nPriority: ${t.priority}\nStatus: ${t.status}\nCategory: ${t.category}`
        }]
      })
    });
    const data = await resp.json();
    ta.value = data.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  } catch (e) {
    ta.value = 'Could not generate suggestion. Check your API key and connection.';
  }

  ta.disabled = false;
  ta.focus();
}

function setAiContent(id, html) {
  const el = document.getElementById('ai-content-' + id);
  if (el) el.innerHTML = html;
}

// ── Ticket Actions ─────────────────────────────────────────────────────────

async function changeStatus(id, val) {
  const t = tickets.find(x => x.id === id);
  if (!t) return;
  const prev = t.status;
  t.status = val;
  filterTickets();
  delete aiCache[id + ':' + val];

  try {
    await patchTicket(id, { status: val });
    showToast(`✓ Status updated to ${statusLabel(val)}`);
  } catch (e) {
    t.status = prev;
    filterTickets();
    showToast(`Error: ${e.message}`);
  }
}

async function deleteTicket(id) {
  const t = tickets.find(x => x.id === id);
  if (!t) return;
  if (!confirm(`Delete ticket ${id}: "${t.title}"?\n\nThis cannot be undone.`)) return;

  try {
    await sbFetch(`/tickets?id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
    tickets = tickets.filter(x => x.id !== id);
    selectedId = null;
    document.getElementById('detail-pane').innerHTML = `
      <div class="empty-state">
        <div class="empty-icon"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></div>
        <div class="empty-title">Ticket deleted</div>
        <div class="empty-sub">Select another ticket from the list</div>
      </div>`;
    filterTickets();
    showToast(`✓ Ticket ${id} deleted`);
  } catch(e) {
    showToast(`Error: ${e.message}`);
  }
}

function sendReply(id) {
  const ta = document.getElementById('reply-' + id);
  if (!ta || !ta.value.trim()) return;
  ta.value = '';
  showToast('✓ Reply sent');
}

function addNote(id) {
  const ta = document.getElementById('reply-' + id);
  if (!ta || !ta.value.trim()) return;
  ta.value = '';
  showToast('✓ Internal note added');
}

// ── Modal ──────────────────────────────────────────────────────────────────

function openModal() {
  document.getElementById('modal').style.display = 'flex';
  populateAssignDropdown();
  setTimeout(() => document.getElementById('new-title').focus(), 100);
}

function closeModal() {
  document.getElementById('modal').style.display = 'none';
}

async function createTicket() {
  const title     = document.getElementById('new-title').value.trim();
  const requester = document.getElementById('new-requester').value.trim();
  if (!title)     { document.getElementById('new-title').focus(); return; }
  if (!requester) { document.getElementById('new-requester').focus(); return; }

  const nextNum = tickets.length
    ? Math.max(...tickets.map(t => parseInt((t.id || '0').replace(/\D/g, '')) || 0)) + 1
    : 1;
  const id = 'TK-' + String(nextNum).padStart(3, '0');

  const newTicket = {
    id,
    title,
    requester,
    priority:    document.getElementById('new-priority').value,
    status:      'open',
    category:    document.getElementById('new-category').value,
    assigned:    document.getElementById('new-assigned').value,
    created:     new Date().toISOString().slice(0, 10),
    description: document.getElementById('new-desc').value.trim() || 'No description provided.'
  };

  closeModal();
  ['new-title','new-requester','new-desc'].forEach(fid => {
    document.getElementById(fid).value = '';
  });

  try {
    if (supabaseKey) {
      const saved = await insertTicket(newTicket);
      tickets.unshift(saved || newTicket);
    } else {
      tickets.unshift(newTicket);
    }
    setView('all');
    filterTickets();
    selectTicket(newTicket.id);
    showToast(`✓ Ticket ${id} created`);
  } catch (e) {
    showToast(`Error saving ticket: ${e.message}`);
  }
}

// ── Credentials ────────────────────────────────────────────────────────────

function saveApiKey() {
  const input = document.getElementById('api-key-input');
  if (!input) return;
  apiKey = input.value.trim();
  localStorage.setItem('hd_api_key', apiKey);
  updateSyncStatus();
  if (selectedId) selectTicket(selectedId);
  showToast('✓ Anthropic API key saved');
}

function saveSupabaseKey() {
  const input = document.getElementById('sb-key-input');
  if (!input) return;
  supabaseKey = input.value.trim();
  localStorage.setItem('hd_supabase_key', supabaseKey);
  updateSyncStatus();
  loadTickets();
  showToast('✓ Supabase key saved — loading tickets…');
}

// ── Utils ──────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); document.getElementById('search').focus(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'n') { e.preventDefault(); openModal(); }
});

// ── AI Agent ───────────────────────────────────────────────────────────────

const EDGE_FN_URL = 'https://xphtitfasgstjvqkkdvs.supabase.co/functions/v1/helpdesk-agent';

function openAgentPanel() {
  document.getElementById('agent-panel').style.display = 'flex';
  loadAgentLogs();
}

function closeAgentPanel() {
  document.getElementById('agent-panel').style.display = 'none';
}

async function loadAgentLogs() {
  const el = document.getElementById('agent-log-content');
  try {
    const data = await sbFetch('/agent_logs?select=*&order=created_at.desc&limit=30');
    if (!data || data.length === 0) {
      el.innerHTML = '<div style="color:var(--text-3);font-size:13px">No agent activity yet. Run a task above.</div>';
      return;
    }
    el.innerHTML = data.map(log => `
      <div class="log-entry">
        <span class="log-action log-${log.action}">${log.action.replace('_', ' ')}</span>
        <div>
          <div style="color:var(--text)">${escHtml(log.detail || '')}</div>
          <div style="color:var(--text-3);font-size:11px;margin-top:2px">${new Date(log.created_at).toLocaleString()}</div>
        </div>
      </div>
    `).join('');
  } catch(e) {
    el.innerHTML = `<div style="color:var(--red);font-size:13px">Could not load logs: ${escHtml(e.message)}</div>`;
  }
}

async function runAgent(action) {
  const el = document.getElementById('agent-log-content');
  el.innerHTML = `<div class="agent-running"><div class="spinner"></div> Running agent task: <strong>${action}</strong>…</div>`;

  try {
    const resp = await fetch(`${EDGE_FN_URL}?action=${action}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json'
      }
    });

    const result = await resp.json();

    if (!result.ok) throw new Error(result.error || 'Agent failed');

    // Show result summary
    let summary = [];
    if (result.escalate) summary.push(`🚨 Escalated ${result.escalate.escalated} ticket(s)`);
    if (result.assign)   summary.push(`👤 Assigned ${result.assign.assigned} ticket(s)`);
    if (result.replies)  summary.push(`✉️ Generated ${result.replies.replies_generated} reply suggestion(s)`);
    if (result.report)   summary.push(`📊 Daily report generated`);

    showToast(`✓ Agent complete — ${summary.join(', ') || 'No actions needed'}`);

    // Reload tickets and logs
    await loadTickets();
    await loadAgentLogs();

    // If a report was generated, show it
    if (result.report?.report) {
      const logEl = document.getElementById('agent-log-content');
      const reportDiv = document.createElement('div');
      reportDiv.style.cssText = 'background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:12px;font-size:12px;line-height:1.7;white-space:pre-wrap;margin-bottom:12px;color:var(--text-2)';
      reportDiv.textContent = result.report.report;
      logEl.prepend(reportDiv);
    }

  } catch(e) {
    el.innerHTML = `<div style="color:var(--red);font-size:13px">Agent error: ${escHtml(e.message)}</div>`;
    showToast(`Agent error: ${e.message}`);
  }
}

// ── Employees ──────────────────────────────────────────────────────────────

const CATEGORIES = ['Hardware', 'Software', 'Network', 'Account', 'Other'];
let employeesCache = [];

async function loadEmployees() {
  try {
    const data = await sbFetch('/agents?select=*&order=name.asc');
    employeesCache = data || [];
    return employeesCache;
  } catch(e) {
    console.error('Failed to load employees:', e);
    return [];
  }
}

async function populateAssignDropdown() {
  const sel = document.getElementById('new-assigned');
  if (!sel) return;
  const emps = employeesCache.length ? employeesCache : await loadEmployees();
  const active = emps.filter(e => e.active);
  sel.innerHTML = '<option value="">— Unassigned —</option>' +
    active.map(e => `<option value="${escHtml(e.name)}">${escHtml(e.name)}</option>`).join('');
}

// Also populate the reassign dropdown inside ticket detail
function populateReassignSelect(ticketId, currentAssigned) {
  const active = employeesCache.filter(e => e.active);
  return `<select onchange="reassignTicket('${ticketId}', this.value)" style="border:none;background:transparent;font-size:13px;font-weight:500;font-family:var(--font);color:var(--color-text-primary);cursor:pointer;width:100%;outline:none">
    <option value="">— Unassigned —</option>
    ${active.map(e => `<option value="${escHtml(e.name)}"${currentAssigned === e.name ? ' selected' : ''}>${escHtml(e.name)}</option>`).join('')}
  </select>`;
}

async function reassignTicket(id, agentName) {
  const t = tickets.find(x => x.id === id);
  if (!t) return;
  const prev = t.assigned;
  t.assigned = agentName;
  try {
    await patchTicket(id, { assigned: agentName, status: agentName ? 'progress' : t.status });
    if (agentName) t.status = 'progress';
    filterTickets();
    showToast(agentName ? `✓ Assigned to ${agentName}` : '✓ Unassigned');
  } catch(e) {
    t.assigned = prev;
    showToast(`Error: ${e.message}`);
  }
}

// ── Employees Panel ────────────────────────────────────────────────────────

async function openEmployeesPanel() {
  document.getElementById('employees-panel').style.display = 'flex';
  await renderEmployeesList();
}

function closeEmployeesPanel() {
  document.getElementById('employees-panel').style.display = 'none';
}

async function renderEmployeesList() {
  const el = document.getElementById('employees-list');
  el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-3);font-size:13px;display:flex;align-items:center;justify-content:center;gap:8px"><div class="spinner"></div> Loading…</div>`;

  const emps = await loadEmployees();

  if (!emps.length) {
    el.innerHTML = `<div style="padding:30px;text-align:center;color:var(--text-3);font-size:13px">No employees yet. Click "+ Add Employee" to get started.</div>`;
    return;
  }

  el.innerHTML = emps.map(e => {
    const initials = e.name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
    const specs = (e.specialties || []).map(s => `<span class="emp-spec-tag">${escHtml(s)}</span>`).join('');
    return `
      <div class="employee-row${e.active ? '' : ' inactive'}">
        <div class="emp-avatar" style="background:${avatarColor(e.name)}">${initials}</div>
        <div class="emp-info">
          <div class="emp-name">${escHtml(e.name)} ${e.active ? '' : '<span style="font-size:10px;color:var(--text-3);font-weight:400">(inactive)</span>'}</div>
          <div class="emp-email">${escHtml(e.email || 'No email')}</div>
          <div class="emp-specialties">${specs || '<span style="font-size:11px;color:var(--text-3)">No specialties</span>'}</div>
        </div>
        <div class="emp-actions">
          <button class="emp-btn" onclick="openEditEmployeeModal(${e.id})">Edit</button>
          <button class="emp-btn" onclick="toggleEmployeeActive(${e.id}, ${e.active})">${e.active ? 'Deactivate' : 'Activate'}</button>
          <button class="emp-btn danger" onclick="deleteEmployee(${e.id}, '${escHtml(e.name)}')">Remove</button>
        </div>
      </div>
    `;
  }).join('');
}

function avatarColor(name) {
  const colors = ['#2563eb','#7c3aed','#db2777','#059669','#d97706','#dc2626','#0891b2'];
  let hash = 0;
  for (let c of name) hash = (hash * 31 + c.charCodeAt(0)) % colors.length;
  return colors[Math.abs(hash)];
}

// ── Add / Edit Employee Modal ───────────────────────────────────────────────

function buildSpecialtyCheckboxes(selected = []) {
  return CATEGORIES.map(cat => `
    <label class="spec-check${selected.includes(cat) ? ' checked' : ''}">
      <input type="checkbox" value="${cat}"${selected.includes(cat) ? ' checked' : ''} onchange="this.closest('label').classList.toggle('checked', this.checked)"> ${cat}
    </label>
  `).join('');
}

function toggleSpec(label) {
  label.classList.toggle('checked');
  label.querySelector('input').checked = label.classList.contains('checked');
}

function getSelectedSpecialties() {
  return [...document.querySelectorAll('#specialty-checkboxes input:checked')].map(i => i.value);
}

function openAddEmployeeModal() {
  document.getElementById('emp-id').value = '';
  document.getElementById('emp-name').value = '';
  document.getElementById('emp-email').value = '';
  document.getElementById('emp-active').value = 'true';
  document.getElementById('specialty-checkboxes').innerHTML = buildSpecialtyCheckboxes();
  document.getElementById('emp-modal-title').textContent = 'Add Employee';
  document.getElementById('emp-save-btn').textContent = 'Add Employee';
  document.getElementById('employee-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('emp-name').focus(), 100);
}

function openEditEmployeeModal(id) {
  const e = employeesCache.find(x => x.id === id);
  if (!e) return;
  document.getElementById('emp-id').value = e.id;
  document.getElementById('emp-name').value = e.name;
  document.getElementById('emp-email').value = e.email || '';
  document.getElementById('emp-active').value = String(e.active);
  document.getElementById('specialty-checkboxes').innerHTML = buildSpecialtyCheckboxes(e.specialties || []);
  document.getElementById('emp-modal-title').textContent = 'Edit Employee';
  document.getElementById('emp-save-btn').textContent = 'Save Changes';
  document.getElementById('employee-modal').style.display = 'flex';
}

function closeAddEmployeeModal() {
  document.getElementById('employee-modal').style.display = 'none';
}

async function saveEmployee() {
  const id = document.getElementById('emp-id').value;
  const name = document.getElementById('emp-name').value.trim();
  if (!name) { document.getElementById('emp-name').focus(); return; }

  const payload = {
    name,
    email: document.getElementById('emp-email').value.trim(),
    specialties: getSelectedSpecialties(),
    active: document.getElementById('emp-active').value === 'true'
  };

  try {
    if (id) {
      await sbFetch(`/agents?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      showToast(`✓ ${name} updated`);
    } else {
      await sbFetch('/agents', {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: JSON.stringify(payload)
      });
      showToast(`✓ ${name} added`);
    }
    closeAddEmployeeModal();
    await renderEmployeesList();
    await populateAssignDropdown();
  } catch(e) {
    showToast(`Error: ${e.message}`);
  }
}

async function toggleEmployeeActive(id, currentActive) {
  try {
    await sbFetch(`/agents?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ active: !currentActive }) });
    showToast(currentActive ? '✓ Employee deactivated' : '✓ Employee activated');
    await renderEmployeesList();
    await populateAssignDropdown();
  } catch(e) {
    showToast(`Error: ${e.message}`);
  }
}

async function deleteEmployee(id, name) {
  if (!confirm(`Remove ${name} from the system? This cannot be undone.`)) return;
  try {
    await sbFetch(`/agents?id=eq.${id}`, { method: 'DELETE' });
    showToast(`✓ ${name} removed`);
    await renderEmployeesList();
    await populateAssignDropdown();
  } catch(e) {
    showToast(`Error: ${e.message}`);
  }
}
