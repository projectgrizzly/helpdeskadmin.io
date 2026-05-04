# HelpDesk — Standalone Support Ticketing System

A fully self-contained help desk ticketing app with AI-powered analysis and reply suggestions via the Anthropic API.

## Getting Started

### Option 1: Open directly in browser
Just double-click `index.html` — no build step, no server required.

### Option 2: Serve locally (recommended for API features)
```bash
# Python
python -m http.server 8080

# Node.js
npx serve .

# Then open: http://localhost:8080
```

## AI Features Setup

1. Get an API key from https://console.anthropic.com
2. Open the app and select any ticket
3. Paste your key in the yellow API key notice and click Save
4. Your key is stored in `localStorage` — it persists between sessions

API calls go directly to `api.anthropic.com` from your browser.

## Features

- **Ticket management** — Create, view, update, and filter tickets
- **Priority levels** — Urgent, High, Medium, Low with color coding
- **Status workflow** — Open → In Progress → Resolved → Closed
- **AI ticket analysis** — Auto-generates summary, root cause, and resolution steps
- **AI reply suggestions** — One-click professional response drafting
- **Search & filter** — Search by title, requester, category, or ID
- **Sort** — By newest, priority, or status
- **Sidebar views** — All, Open, In Progress, Resolved, Urgent
- **Keyboard shortcuts** — `⌘K` to search, `⌘N` for new ticket, `Esc` to close modal

## File Structure

```
helpdesk/
├── index.html   # App shell and layout
├── style.css    # All styles
├── app.js       # All logic (tickets, AI, filtering)
└── README.md    # This file
```

## Extending to a Real Backend

The ticket data structure is in `app.js` — replace the in-memory `tickets` array with API calls to your backend (Supabase, Firebase, a REST API, etc.).

Each ticket object:
```json
{
  "id": "TK-001",
  "title": "Issue title",
  "requester": "Name or email",
  "priority": "Urgent | High | Medium | Low",
  "status": "open | progress | resolved | closed",
  "category": "Hardware | Software | Network | Account | Other",
  "assigned": "Agent name",
  "created": "2026-05-03",
  "description": "Full description text"
}
```
