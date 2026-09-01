# 🖥️ Project Golem Web Dashboard Guide

> Last Updated: 2026-03-24  
> Tech Stack: Next.js + Tailwind CSS + Socket.io

## 1. How to Start

```bash
# Development Mode (with Hot Reload)
cd web-dashboard
npm run dev        # Default: http://localhost:3000

# Production Mode (Static Export)
npm run build
# Served by the project root's server.js
node server.js     # Default: http://localhost:3000
```

> The Dashboard and the main Bot (`index.js`) are **independent processes**. The Dashboard communicates with the Bot in real-time via Socket.io.

---

## 2. Page Overview

### 🎛️ Tactical Console (`/dashboard`)
The home view providing an overview of:
- Active Golem status
- Dynamic context imagery (switches based on active skills/multi-agent scenarios)
- Quick action shortcuts

---

### 💻 Web Terminal (`/dashboard/terminal`)
**Communicate directly with Golem** and observe real-time responses. This is the web equivalent of the admin Telegram terminal.

Features:
- Real-time conversation input
- Full Golem output display (including Action execution logs)
- Instance switching support

---

### 📚 Skill Manager (`/dashboard/skills`)
The central hub for managing Golem's capabilities:
- **List Skills**: View descriptions of CORE and USER skills.
- **Toggle Skills**: Enable or disable specific functions.
- **Export Skill Book**: Download the full skill book as Markdown.
- **Export Single Skill**: Download the selected skill as a `.md` file.
- **Import Skill Book**: Upload `.md/.json` backups with pre-import preview and conflict strategy.
- **Inject Skills**: Reload skill books into Gemini (equivalent to `/reload`).

---

### 🎭 Persona Settings (`/dashboard/persona`)
Template management and Persona Market page:
- Manage local presets (create, edit, delete, search, categorize).
- Browse market personas and apply with one click.
- Fine-tune in the settings drawer, then save via **Save & Restart Window**.

---

### 🗂️ Prompt Pool (`/dashboard/prompt-pool`)
Shortcut command management center:
- Create, edit, and delete shortcut prompts.
- View recent usage records and quick-copy actions.
- Detect legacy conflicts and auto-repair in one click.

---

### 📈 Prompt Trends (`/dashboard/prompt-trends`)
Visual analytics for prompt usage:
- 14-day overall usage trend
- 14-day single-shortcut trend
- Shortcut ranking with period filters

---

### 📓 Bond Journal (`/dashboard/diary`)
AI/User journal center:
- Create user journal entries, AI journals, and AI thoughts.
- One-click diary rotation with multi-tier summaries.
- Backup, restore, and restore-preview workflows.

---

### 👥 Agent Room (`/dashboard/agents`)
**The visual interface for the InteractiveMultiAgent system**.
- Configure the participating agent list (Name, Role, Personality).
- Set the maximum number of discussion rounds.
- Start roundtable discussions.
- Real-time display of agent dialogue and consensus summaries.

---

### 🔌 MCP Tools (`/dashboard/mcp`) 🆕
**Model Context Protocol Management Center** for integrating external tools and data sources.
- **Server Management**: Add, edit, or delete MCP Servers (stdio transport).
- **Connection Test**: One-click test for server connectivity.
- **Tool Inspector**: Real-time display of tool names and parameter schemas.
- **Live Logs**: Visualize JSON-RPC traffic for debugging.

---

### 🏢 Automation Center (`/dashboard/office`)
Manages **automated tasks**, including schedule checks, system introspection, and periodic maintenance logs.

---

### 🧠 Memory Core (`/dashboard/memory`)
The management interface for the vector memory store:
- **Browse Memory**: List all stored long-term memory entries.
- **Semantic Search**: Test the semantic search engine with keywords.
- **Delete/Reset**: Remove specific entries or clear the entire memory store.

---

### ⚙️ System Settings (`/dashboard/settings`)
System configuration and status monitoring:
- **Golem List**: View all instances and their health status.
- **Env Variables**: View and modify `.env` settings.
- **Log Management**: Trigger log compression and view history.
- **System Upgrade**: Trigger hot-updates from GitHub.

---

## 3. Recent Updates (2026-03-24)

### 3.1 Global i18n (Traditional Chinese / English)
- Added a language toggle in the dashboard sidebar.
- Locale preference is persisted in browser storage (`localStorage`).
- Core pages and key drawers/modals are now fully bilingual.

### 3.2 Home Update Marquee (GitHub Update Signal)
- The dashboard home checks `/api/system/update/check` periodically.
- When the Git branch is behind or a newer version is available, an update marquee is shown.
- The marquee includes a shortcut CTA to System Settings for one-click update.

### 3.3 Skill/Persona Market Source-text Policy
- Skill Market now prefers source fields (such as `original_description`, `category_name.en`).
- Persona Market now prefers original `name / description / role` fields.
- This keeps market content semantically faithful to upstream sources.

### 3.4 Persona Apply Stability Fix
- Fixed repeated form hydration overriding applied persona values.
- Applying a market persona can now be edited and saved reliably.

---

## 4. Backend APIs (`web-dashboard/server.js`)

| Route | Description |
|------|------|
| `GET /api/system/status` | Get runtime/system status |
| `GET /api/system/config` | Read system config (including memory mode) |
| `POST /api/system/config` | Update system config (guarded) |
| `POST /api/system/login` / `POST /api/system/logout` | Remote login/logout |
| `GET /api/system/security/events` | Read security audit events |
| `GET /api/golems` | Get Golem list |
| `POST /api/chat` | Send a web chat message to Golem |
| `GET /api/diary` | Read diary timeline (with rotation metadata) |
| `POST /api/diary/rotate` | Force diary rotation (7-day raw retention + weekly/monthly/yearly summaries) |
| `GET /api/diary/rotation/history` | Read diary rotation history |
| `GET /api/diary/backups` | List available diary SQLite backups |
| `GET /api/diary/backup/download?file=...` | Download a specific diary SQLite backup |
| `POST /api/diary/backup` | Create a diary SQLite backup |
| `POST /api/diary/backup/cleanup` | Trigger immediate cleanup for old diary backups |
| `GET /api/diary/restore/preview?file=...` | Preview restore diff/risk before restore |
| `POST /api/diary/restore` | Restore diary SQLite from a selected backup |
| `GET /api/skills/export` | Export full skill book or a specific skill |
| `POST /api/skills/import` | Import skill book from JSON/Markdown |
| `GET /api/memory` | Read memory entries |
| `POST /api/upload` | Upload file (size-limited) |
| `GET /api/mcp/servers` | Get MCP Server list |
| `POST /api/mcp/servers/:name/test` | Test specific MCP connection |
| `GET /api/mcp/logs` | Read MCP call logs |
| `Socket.IO` | Real-time push for responses, system events, and MCP logs |

### Security Hardening Notes

- API-level rate limiting and remote session authentication are enabled.
- Sensitive operations (restart/shutdown, MCP write, skill/memory mutations) are protected by operation guards.
- If `SYSTEM_OP_TOKEN` is set, sensitive operations additionally require `x-system-op-token`.
- Uploads and attachment paths are validated with size and directory-boundary checks.

### Diary Rotation Policy (Recommended)

You can tune these in `.env`:

- `DIARY_RAW_RETENTION_DAYS` (minimum 7)
- `DIARY_WEEKLY_RETENTION_DAYS`
- `DIARY_MONTHLY_RETENTION_DAYS`
- `DIARY_ROTATE_MIN_INTERVAL_MS`
- `DIARY_BACKUP_MAX_FILES`
- `DIARY_BACKUP_RETENTION_DAYS`

Diary storage now uses SQLite (WAL). Legacy `diary-book.json` is auto-migrated on first access.

---

## 5. Multi-Agent Workflow

```
User Configuration:
  Task description, Agent roles, Max rounds
        ↓
InteractiveMultiAgent.startConversation()
        ↓
  Round 1: Agent A speaks → Agent B speaks → Agent C speaks
  Round 2: Each agent responds to others + User can intervene via @mentions
  ...
  Consensus detection → Early termination
        ↓
_generateSummary() → Final consensus summary sent to user
```
