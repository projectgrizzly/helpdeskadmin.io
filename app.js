// ── Config ─────────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://xphtitfasgstjvqkkdvs.supabase.co/rest/v1';

const PRIORITY_ORDER = { Urgent: 0, High: 1, Normal: 2, Low: 3, Info: 4 };

let tickets = [];
let selectedId = null;
let currentView = 'all';
let aiCache = {};
let apiKey = localStorage.getItem('hd_api_key') || '';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhwaHRpdGZhc2dzdGp2cWtrZHZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5MTQzMDQsImV4cCI6MjA5MzQ5MDMwNH0.sjjsfDCeiEWPih2f3eH5rShhvEZZXgS3ApcSy0B0S-M';
let supabaseKey = localStorage.getItem('hd_supabase_key') || SUPABASE_ANON_KEY;

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
  if (resp.status === 204 || resp.headers.get('content-length') === '0') return null;
  const text = await resp.text();
  if (!text) return null;
  return JSON.parse(text);
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

document.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('search').addEventListener('input', filterTickets);
  document.getElementById('sort-sel').addEventListener('change', filterTickets);

  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', e => {
      if (el.getAttribute('href') && el.getAttribute('href') !== '#') return;
      e.preventDefault();
      setView(el.dataset.view);
    });
  });

  await initAuth();

  loadDepartmentsAndLocations();
  loadEmployees().then(() => loadTickets()).then(() => {
    startRealtimeSync();
  });
});

// ── Realtime Sync ──────────────────────────────────────────────────────────

let realtimeSocket = null;
let pollInterval = null;

function startRealtimeSync() {
  // Try Supabase Realtime WebSocket first
  try {
    const wsUrl = `wss://xphtitfasgstjvqkkdvs.supabase.co/realtime/v1/websocket?apikey=${supabaseKey}&vsn=1.0.0`;
    realtimeSocket = new WebSocket(wsUrl);

    realtimeSocket.onopen = () => {
      // Join the tickets table channel
      realtimeSocket.send(JSON.stringify({
        topic: 'realtime:public:tickets',
        event: 'phx_join',
        payload: { config: { broadcast: { self: false }, postgres_changes: [{ event: '*', schema: 'public', table: 'tickets' }] } },
        ref: '1'
      }));
      console.log('[Realtime] Connected');
      setSyncIndicator('realtime');
    };

    realtimeSocket.onmessage = async (e) => {
      const msg = JSON.parse(e.data);
      const payload = msg.payload;

      if (msg.event === 'postgres_changes' || (payload?.data?.type)) {
        const changeType = payload?.data?.type || payload?.type;
        const record = payload?.data?.record || payload?.record;
        const oldRecord = payload?.data?.old_record || payload?.old_record;

        if (changeType === 'INSERT' && record) {
          if (!tickets.find(t => t.id === record.id)) {
            tickets.unshift(record);
            filterTickets();
            if (record.priority === 'Urgent' && shouldNotify('urgent')) {
              showToast(`🚨 Urgent ticket: ${record.id} — ${record.title?.slice(0, 40)}`);
            } else {
              showToast(`🎫 New ticket: ${record.id} — ${record.title?.slice(0, 40)}`);
            }
          }
        } else if (changeType === 'UPDATE' && record) {
          // Ticket updated externally
          const idx = tickets.findIndex(t => t.id === record.id);
          if (idx !== -1) {
            tickets[idx] = { ...tickets[idx], ...record };
            filterTickets();
            if (selectedId === record.id) selectTicket(record.id);
          }
        } else if (changeType === 'DELETE' && oldRecord) {
          // Ticket deleted externally
          tickets = tickets.filter(t => t.id !== oldRecord.id);
          if (selectedId === oldRecord.id) {
            selectedId = null;
            document.getElementById('detail-pane').innerHTML = `<div class="empty-state"><div class="empty-title">Ticket was deleted</div></div>`;
          }
          filterTickets();
        }
      }

      // Respond to heartbeat
      if (msg.event === 'heartbeat') {
        realtimeSocket.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: null }));
      }
    };

    realtimeSocket.onerror = () => {
      console.warn('[Realtime] WebSocket error — falling back to polling');
      startPolling();
    };

    realtimeSocket.onclose = () => {
      console.warn('[Realtime] WebSocket closed — falling back to polling');
      setSyncIndicator('polling');
      startPolling();
    };

  } catch(e) {
    console.warn('[Realtime] Could not connect — falling back to polling');
    startPolling();
  }
}

function startPolling() {
  if (pollInterval) return; // already polling
  setSyncIndicator('polling');
  pollInterval = setInterval(async () => {
    try {
      const data = await sbFetch('/tickets?select=*&order=created.desc');
      const incoming = data || [];

      // Check for new tickets
      const existingIds = new Set(tickets.map(t => t.id));
      const newTickets = incoming.filter(t => !existingIds.has(t.id));

      if (newTickets.length > 0) {
        newTickets.forEach(t => tickets.unshift(t));
        filterTickets();
        newTickets.forEach(t => showToast(`🎫 New ticket: ${t.id} — ${t.title?.slice(0, 40)}`));
      }

      // Check for updates to existing tickets
      let updated = false;
      incoming.forEach(incoming => {
        const idx = tickets.findIndex(t => t.id === incoming.id);
        if (idx !== -1 && JSON.stringify(tickets[idx]) !== JSON.stringify(incoming)) {
          tickets[idx] = incoming;
          updated = true;
        }
      });

      if (updated) filterTickets();
    } catch(e) {
      console.warn('[Poll] Failed:', e.message);
    }
  }, 15000); // poll every 15 seconds
}

function setSyncIndicator(mode) {
  const dot = document.getElementById('sync-dot');
  const label = document.getElementById('sync-label');
  if (mode === 'realtime') {
    dot.style.background = 'var(--green)';
    label.textContent = 'Live';
    label.style.color = 'var(--green)';
    dot.style.animation = 'pulse 2s infinite';
  } else {
    dot.style.background = 'var(--blue)';
    label.textContent = 'Syncing…';
    label.style.color = 'var(--blue)';
    dot.style.animation = 'none';
  }
}

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

  const configNotice = !apiKey ? `
    <div class="api-notice">
      <strong>Setup required</strong>
      <div style="margin-top:8px">Anthropic key missing — AI features disabled.<div class="api-key-field"><input type="password" id="api-key-input" placeholder="sk-ant-…"><button onclick="saveApiKey()">Save AI key</button></div></div>
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
        ${t.requester_email ? `<div style="font-size:11px;color:var(--text-3);margin-top:2px">${escHtml(t.requester_email)}</div>` : ''}
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
      <div class="meta-card">
        <label>Department</label>
        <div class="meta-val">${escHtml(t.department || '—')}</div>
      </div>
      <div class="meta-card">
        <label>Location</label>
        <div class="meta-val">${escHtml(t.location || '—')}</div>
      </div>
      <div class="meta-card">
        <label>Due Date</label>
        <div class="meta-val">${t.due_date ? new Date(t.due_date).toLocaleDateString() : '—'}</div>
      </div>
    </div>

    <!-- What details -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px">
      <div class="meta-card">
        <label>Device Type</label>
        <div class="meta-val">${escHtml(t.device_type || '—')}</div>
      </div>
      <div class="meta-card">
        <label>Software Type</label>
        <div class="meta-val">${escHtml(t.software_type || '—')}</div>
      </div>
      <div class="meta-card">
        <label>Subcategory</label>
        <div class="meta-val">${escHtml(t.subcategory || '—')}</div>
      </div>
    </div>

    <!-- Who Will -->
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:14px">
      <div class="meta-card">
        <label>Escalation</label>
        <select onchange="updateTicketField('${escHtml(t.id)}','escalation_level',this.value)">
          ${['None','Level 1','Level 2','Manufacturer'].map(l =>
            `<option${t.escalation_level===l?' selected':''}>${l}</option>`
          ).join('')}
        </select>
      </div>
      <div class="meta-card">
        <label>Content Expert</label>
        <div class="meta-val">${escHtml(t.content_expert || '—')}</div>
      </div>
      <div class="meta-card">
        <label>Regulation</label>
        <div class="meta-val">${escHtml(t.regulation || 'None')}</div>
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

    <div class="resolution-box" id="resolution-box-${escHtml(t.id)}">
      <div class="section-label" style="color:var(--green);margin-bottom:12px">
        📋 Resolution Documentation — How?
      </div>
      <div class="resolution-field">
        <label>What was the problem?</label>
        <textarea placeholder="Describe the root cause…" onchange="updateTicketField('${escHtml(t.id)}','resolution_what',this.value)">${escHtml(t.resolution_what||'')}</textarea>
      </div>
      <div class="resolution-field">
        <label>Who was affected?</label>
        <input type="text" placeholder="User, department, or system affected…" value="${escHtml(t.resolution_who||'')}" onchange="updateTicketField('${escHtml(t.id)}','resolution_who',this.value)">
      </div>
      <div class="resolution-field">
        <label>How was it fixed?</label>
        <textarea placeholder="Steps taken to resolve…" onchange="updateTicketField('${escHtml(t.id)}','resolution_how',this.value)">${escHtml(t.resolution_how||'')}</textarea>
      </div>
      <div class="resolution-field">
        <label>Additional Notes</label>
        <textarea placeholder="Any extra context, follow-up actions, or links…" onchange="updateTicketField('${escHtml(t.id)}','resolution_notes',this.value)">${escHtml(t.resolution_notes||'')}</textarea>
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

async function updateTicketField(id, field, value) {
  const t = tickets.find(x => x.id === id);
  if (!t) return;
  t[field] = value;
  try {
    await patchTicket(id, { [field]: value });
  } catch(e) {
    showToast(`Error saving: ${e.message}`);
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
  populateContentExpert();
  populateDeptLocation();
  updateSubcategory();
  setTimeout(() => document.getElementById('new-requester').focus(), 100);
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
    requester_email: document.getElementById('new-requester-email')?.value.trim() || '',
    priority:    document.getElementById('new-priority').value,
    status:      'open',
    category:    document.getElementById('new-category').value,
    subcategory: document.getElementById('new-subcategory')?.value || '',
    device_type: document.getElementById('new-device-type')?.value || '',
    software_type: document.getElementById('new-software-type')?.value || '',
    department:  document.getElementById('new-department')?.value || '',
    location:    document.getElementById('new-location')?.value || '',
    due_date:    document.getElementById('new-due-date')?.value || null,
    regulation:  document.getElementById('new-regulation')?.value || '',
    source:      document.getElementById('new-source')?.value || 'manual',
    assigned:    document.getElementById('new-assigned').value,
    content_expert: document.getElementById('new-content-expert')?.value || '',
    escalation_level: document.getElementById('new-escalation-level')?.value || 'None',
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

// ── Chat ───────────────────────────────────────────────────────────────────

const REALTIME_URL = 'wss://xphtitfasgstjvqkkdvs.supabase.co/realtime/v1/websocket';

let chatOpen = false;
let channels = [];
let activeChannelId = null;
let activeChannelName = 'general';
let chatMessages = [];
let chatSocket = null;
let unreadCount = 0;
let lastSender = null;
let lastMsgTime = null;

function toggleChat() {
  chatOpen = !chatOpen;
  const panel = document.getElementById('chat-panel');
  const detailPane = document.getElementById('detail-pane');
  panel.style.display = chatOpen ? 'flex' : 'none';
  detailPane.style.display = chatOpen ? 'none' : 'flex';
  if (chatOpen) {
    resetUnread();
    loadChannels();
    startChatRealtime();
    loadSenderName();
  } else {
    if (chatSocket) { chatSocket.close(); chatSocket = null; }
  }
}

function loadSenderName() {
  const saved = localStorage.getItem('hd_chat_name') || '';
  document.getElementById('chat-sender-name').value = saved;
  document.getElementById('chat-sender-name').addEventListener('change', e => {
    localStorage.setItem('hd_chat_name', e.target.value.trim());
  });
}

function getSenderName() {
  const name = document.getElementById('chat-sender-name')?.value.trim();
  if (!name) { showToast('Enter your name in the chat panel first'); return null; }
  localStorage.setItem('hd_chat_name', name);
  return name;
}

async function loadChannels() {
  try {
    const data = await sbFetch('/channels?select=*&order=name.asc');
    channels = data || [];
    renderChannelList();
    if (channels.length && !activeChannelId) {
      selectChannel(channels[0].id, channels[0].name, channels[0].description);
    }
  } catch(e) { console.error('Failed to load channels:', e); }
}

function renderChannelList() {
  document.getElementById('channel-list').innerHTML = channels.map(c => `
    <div class="channel-item${c.id === activeChannelId ? ' active' : ''}" onclick="selectChannel(${c.id}, '${escHtml(c.name)}', '${escHtml(c.description || '')}')">
      <span style="color:var(--text-3)">#</span> ${escHtml(c.name)}
    </div>
  `).join('');

  // Render agents
  document.getElementById('chat-agent-list').innerHTML = employeesCache
    .filter(e => e.active)
    .map(e => `
      <div class="chat-agent-item">
        <div class="agent-dot" style="background:var(--green)"></div>
        ${escHtml(e.name)}
      </div>
    `).join('') || '<div style="padding:4px 12px;font-size:12px;color:var(--text-3)">No agents</div>';
}

async function selectChannel(id, name, desc) {
  activeChannelId = id;
  activeChannelName = name;
  document.getElementById('chat-channel-name').textContent = `# ${name}`;
  document.getElementById('chat-channel-desc').textContent = desc || '';
  document.getElementById('chat-input').placeholder = `Message #${name}…`;
  renderChannelList();
  await loadMessages();

  // Re-subscribe to new channel
  if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
    chatSocket.send(JSON.stringify({
      topic: `realtime:public:messages:channel_id=eq.${id}`,
      event: 'phx_join',
      payload: { config: { broadcast: { self: true }, postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'messages', filter: `channel_id=eq.${id}` }] } },
      ref: '2'
    }));
  }
}

async function loadMessages() {
  const el = document.getElementById('chat-messages');
  if (!activeChannelId) return;
  el.innerHTML = '<div style="text-align:center;color:var(--text-3);font-size:13px;padding:40px 20px">Loading…</div>';
  try {
    const data = await sbFetch(`/messages?channel_id=eq.${activeChannelId}&select=*&order=created_at.asc&limit=100`);
    chatMessages = data || [];
    renderMessages();
  } catch(e) {
    el.innerHTML = `<div style="color:var(--red);font-size:13px;padding:20px">Failed to load messages: ${escHtml(e.message)}</div>`;
  }
}

function renderMessages() {
  const el = document.getElementById('chat-messages');
  const mySenderName = localStorage.getItem('hd_chat_name') || '';

  if (!chatMessages.length) {
    el.innerHTML = `<div style="text-align:center;color:var(--text-3);font-size:13px;padding:40px 20px">No messages yet. Say hello! 👋</div>`;
    return;
  }

  let html = '';
  let prevSender = null;
  let prevDate = null;

  chatMessages.forEach(msg => {
    const date = new Date(msg.created_at);
    const dateStr = date.toLocaleDateString('en', { weekday:'long', month:'short', day:'numeric' });
    const timeStr = date.toLocaleTimeString('en', { hour:'numeric', minute:'2-digit' });
    const isOwn = msg.sender === mySenderName;

    if (dateStr !== prevDate) {
      html += `<div class="msg-date-divider">${dateStr}</div>`;
      prevDate = dateStr;
      prevSender = null;
    }

    const showHeader = msg.sender !== prevSender;
    if (showHeader) {
      if (prevSender) html += '</div>';
      html += `<div class="msg-group">`;
      html += `<div class="msg-header"><span class="msg-sender">${escHtml(msg.sender)}</span><span class="msg-time">${timeStr}</span></div>`;
    }

    html += `<div class="msg-bubble${isOwn ? ' own' : ''}">${escHtml(msg.content)}</div>`;
    prevSender = msg.sender;
  });

  if (prevSender) html += '</div>';
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}

async function sendMessage() {
  const sender = getSenderName();
  if (!sender) return;
  const input = document.getElementById('chat-input');
  const content = input.value.trim();
  if (!content || !activeChannelId) return;

  input.value = '';

  try {
    await sbFetch('/messages', {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ channel_id: activeChannelId, sender, content })
    });
  } catch(e) {
    showToast(`Error sending: ${e.message}`);
    input.value = content;
  }
}

function startChatRealtime() {
  if (chatSocket) return;
  try {
    chatSocket = new WebSocket(`${REALTIME_URL}?apikey=${supabaseKey}&vsn=1.0.0`);

    chatSocket.onopen = () => {
      chatSocket.send(JSON.stringify({
        topic: 'realtime:public:messages',
        event: 'phx_join',
        payload: { config: { broadcast: { self: true }, postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'messages' }] } },
        ref: '1'
      }));
    };

    chatSocket.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.event === 'heartbeat') {
        chatSocket.send(JSON.stringify({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: null }));
        return;
      }

      const record = msg.payload?.data?.record || msg.payload?.record;
      if (!record) return;

      // Only render if message is for the active channel
      if (record.channel_id === activeChannelId) {
        chatMessages.push(record);
        renderMessages();
      } else {
        // Unread badge for other channels
        if (!chatOpen) incrementUnread();
      }
    };

    chatSocket.onclose = () => { chatSocket = null; };
  } catch(e) {
    console.warn('[Chat Realtime] Failed:', e.message);
  }
}

function incrementUnread() {
  unreadCount++;
  const badge = document.getElementById('chat-unread');
  badge.textContent = unreadCount;
  badge.style.display = 'inline';
}

function resetUnread() {
  unreadCount = 0;
  const badge = document.getElementById('chat-unread');
  badge.style.display = 'none';
}

// ── Auth Init ──────────────────────────────────────────────────────────────

async function initAuth() {
  const ok = await Auth.requireAuth();
  if (!ok) return;

  const prefs = await Auth.loadPrefs();
  const user  = Auth.getUser();

  // Update supabaseKey to use auth token for authenticated requests
  supabaseKey = Auth.getToken();

  // Render user in sidebar
  const name   = prefs.display_name || user?.email?.split('@')[0] || 'Agent';
  const email  = user?.email || '';
  const initials = name.slice(0,2).toUpperCase();
  document.getElementById('user-avatar').textContent = initials;
  document.getElementById('user-name').textContent   = name;
  document.getElementById('user-email').textContent  = email;

  // Render saved filters in sidebar
  renderSavedFilterNav(prefs.saved_filters || []);

  return prefs;
}

function toggleUserMenu() {
  const dd = document.getElementById('user-dropdown');
  dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
}

document.addEventListener('click', e => {
  if (!e.target.closest('.user-menu')) {
    const dd = document.getElementById('user-dropdown');
    if (dd) dd.style.display = 'none';
  }
});

// ── Preferences Panel ──────────────────────────────────────────────────────

function openPrefsPanel() {
  document.getElementById('user-dropdown').style.display = 'none';
  const prefs = Auth.getPrefs();

  // Populate fields
  document.getElementById('pref-display-name').value     = prefs.display_name || '';
  document.getElementById('pref-notify-urgent').checked   = prefs.notify_urgent !== false;
  document.getElementById('pref-notify-assigned').checked = prefs.notify_assigned !== false;
  document.getElementById('pref-notify-resolved').checked = !!prefs.notify_resolved;
  document.getElementById('pref-notify-chat').checked     = prefs.notify_chat !== false;

  renderSavedFiltersList(prefs.saved_filters || []);
  document.getElementById('prefs-panel').style.display = 'flex';
}

function closePrefsPanel() {
  document.getElementById('prefs-panel').style.display = 'none';
}

function renderSavedFiltersList(filters) {
  const el = document.getElementById('saved-filters-list');
  if (!filters.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-3)">No saved filters yet. Add one below.</div>';
    return;
  }
  el.innerHTML = filters.map((f, i) => `
    <div class="saved-filter-item">
      <div>
        <span style="font-weight:500">${escHtml(f.name)}</span>
        <span style="color:var(--text-3);font-size:11px;margin-left:8px">${f.view}</span>
      </div>
      <button onclick="removeSavedFilter(${i})" title="Remove">×</button>
    </div>
  `).join('');
}

function renderSavedFilterNav(filters) {
  // Remove old filter items
  document.querySelectorAll('.nav-filter-item').forEach(el => el.remove());
  const nav  = document.querySelector('.nav');
  const ref  = document.querySelector('.nav-item[data-view="urgent"]')?.parentElement;
  if (!filters.length) return;

  const divider = document.createElement('div');
  divider.className = 'nav-label';
  divider.style.marginTop = '16px';
  divider.textContent = 'My Filters';
  nav.appendChild(divider);

  filters.forEach(f => {
    const el = document.createElement('div');
    el.className = 'nav-filter-item';
    el.innerHTML = `
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>
      ${escHtml(f.name)}
    `;
    el.onclick = () => setView(f.view);
    nav.appendChild(el);
  });
}

function addSavedFilter() {
  const name = document.getElementById('new-filter-name').value.trim();
  const view = document.getElementById('new-filter-view').value;
  if (!name) return;

  const prefs   = Auth.getPrefs();
  const filters = [...(prefs.saved_filters || []), { name, view }];
  Auth.getPrefs().saved_filters = filters;
  renderSavedFiltersList(filters);
  document.getElementById('new-filter-name').value = '';
}

function removeSavedFilter(idx) {
  const prefs   = Auth.getPrefs();
  const filters = (prefs.saved_filters || []).filter((_, i) => i !== idx);
  Auth.getPrefs().saved_filters = filters;
  renderSavedFiltersList(filters);
}

async function savePreferences() {
  const display_name     = document.getElementById('pref-display-name').value.trim();
  const notify_urgent    = document.getElementById('pref-notify-urgent').checked;
  const notify_assigned  = document.getElementById('pref-notify-assigned').checked;
  const notify_resolved  = document.getElementById('pref-notify-resolved').checked;
  const notify_chat      = document.getElementById('pref-notify-chat').checked;
  const saved_filters    = Auth.getPrefs().saved_filters || [];

  await Auth.savePrefs({ display_name, notify_urgent, notify_assigned, notify_resolved, notify_chat, saved_filters });

  // Update sidebar display name
  const initials = (display_name || 'A').slice(0,2).toUpperCase();
  document.getElementById('user-avatar').textContent = initials;
  document.getElementById('user-name').textContent   = display_name || Auth.getUser()?.email?.split('@')[0] || 'Agent';

  // Update chat sender name
  if (display_name) {
    localStorage.setItem('hd_chat_name', display_name);
    const chatInput = document.getElementById('chat-sender-name');
    if (chatInput) chatInput.value = display_name;
  }

  renderSavedFilterNav(saved_filters);
  closePrefsPanel();
  showToast('✓ Preferences saved');
}

// ── Notification helpers ───────────────────────────────────────────────────

function shouldNotify(type) {
  const prefs = Auth.getPrefs();
  if (type === 'urgent')   return prefs.notify_urgent !== false;
  if (type === 'assigned') return prefs.notify_assigned !== false;
  if (type === 'resolved') return !!prefs.notify_resolved;
  if (type === 'chat')     return prefs.notify_chat !== false;
  return true;
}

// ── Subcategories ──────────────────────────────────────────────────────────

const SUBCATEGORIES = {
  Hardware: ['Laptop','Desktop','Printer','Monitor','Keyboard/Mouse','Server','Network Equipment','Other'],
  Software: ['Installation','Crash/Error','Performance','Update/Upgrade','License','Configuration','Other'],
  Network:  ['VPN','WiFi','Internet','DNS','Firewall','Cable/Physical','Other'],
  Account:  ['Password Reset','Account Locked','New Account','Permissions','MFA','Other'],
  Other:    ['General Inquiry','Other']
};

function updateSubcategory(selectedVal = '') {
  const cat = document.getElementById('new-category')?.value || 'Other';
  const sel = document.getElementById('new-subcategory');
  if (!sel) return;
  const opts = SUBCATEGORIES[cat] || SUBCATEGORIES['Other'];
  sel.innerHTML = '<option value="">— Select —</option>' +
    opts.map(o => `<option${o === selectedVal ? ' selected' : ''}>${o}</option>`).join('');
}

// ── Departments & Locations ────────────────────────────────────────────────

let departmentsCache = [];
let locationsCache   = [];

async function loadDepartmentsAndLocations() {
  try {
    [departmentsCache, locationsCache] = await Promise.all([
      sbFetch('/departments?select=*&active=eq.true&order=name.asc'),
      sbFetch('/locations?select=*&active=eq.true&order=name.asc')
    ]);
    departmentsCache = departmentsCache || [];
    locationsCache   = locationsCache   || [];
  } catch(e) { console.warn('Failed to load dept/locations:', e); }
}

function populateDeptLocation() {
  const deptSel = document.getElementById('new-department');
  const locSel  = document.getElementById('new-location');
  if (deptSel) {
    deptSel.innerHTML = '<option value="">— Select —</option>' +
      departmentsCache.map(d => `<option>${escHtml(d.name)}</option>`).join('');
  }
  if (locSel) {
    locSel.innerHTML = '<option value="">— Select —</option>' +
      locationsCache.map(l => `<option>${escHtml(l.name)}</option>`).join('');
  }
}

function populateContentExpert() {
  const sel = document.getElementById('new-content-expert');
  if (!sel) return;
  sel.innerHTML = '<option value="">— None —</option>' +
    employeesCache.filter(e => e.active).map(e => `<option>${escHtml(e.name)}</option>`).join('');
}
