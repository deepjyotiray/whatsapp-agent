# Architecture

## Overview

The secure-agent is a multi-tenant AI agent runtime for WhatsApp. It runs two completely separate pipelines — one for customers, one for admins — that share a common governance layer.

```
Incoming message
      │
      ├── From admin phone? ──► Admin Pipeline (agent loop, 35+ tools, governance)
      │
      └── From anyone else? ──► Customer Pipeline (sanitize → classify → execute)
```

---

## Customer Pipeline

Every customer message passes through 5 sequential gates. If any gate rejects, the message never reaches the next stage.

```
Message ──► Sanitizer ──► Session Check ──► Intent Router ──► Policy Engine ──► Tool Executor ──► Response
```

### Gate 1 — Sanitizer

**File:** `gateway/sanitizer.js`

Blocks malicious input before anything else runs.

| Check | What it catches |
|---|---|
| 13 regex patterns | Prompt injection (`ignore previous instructions`), path traversal (`../../`), command substitution (`$(cmd)`), script tags, eval/exec calls |
| Length limit | Messages over 500 characters are rejected |
| Empty input | Blank or whitespace-only messages |

If blocked → returns `"Your message could not be processed."` — no LLM call, no tool call, no logging of the message content.

### Gate 2 — Session Check

**File:** `runtime/agentChain.js`

Checks if the customer has an active multi-turn session:

- **Active cart** → routes directly to `place_order` tool (skips intent classification entirely)
- **Active support session** → routes to `support` tool
- **Support handoff from order flow** → clears cart, routes to support

This avoids unnecessary LLM calls during multi-turn conversations like ordering or support.

### Gate 3 — Intent Router

**Files:** `gateway/customerRouter.js` → `gateway/intentParser.js`

Two-pass classification:

**Pass 1 — Heuristic (no LLM):**
Keyword matching against hardcoded word lists:
- `MENU_WORDS`: menu, dish, price, biryani, paneer, ...
- `ORDER_WORDS`: order, delivery, status, payment, ...
- `SUPPORT_WORDS`: problem, complaint, refund, human, ...
- `GREET_WORDS`: hi, hello, namaste, thanks, ...
- `BUY_WORDS`: place order, want to order, cart, ...

**Pass 2 — LLM classification:**
Sends the message to the LLM with:
- All intent names from the manifest
- `intent_hints` — plain English descriptions of when each intent should fire
- The business profile description

The LLM returns:
```json
{
  "intent": "show_menu",
  "filter": { "veg": true, "max_price": 200, "query": "paneer" }
}
```

If the LLM fails or returns an unknown intent, the heuristic result is used as fallback.

### Gate 4 — Policy Engine

**File:** `gateway/policyEngine.js`  
**Config:** `policy/policy.yml`

Checks the classified intent against three lists:

```yaml
allowed_intents:
  - greet
  - show_menu
  - order_status
  - place_order
  - support
  - general_chat

restricted_intents:
  - delete_order
  - admin_query
  - modify_price

domain_keywords:
  - menu
  - order
  - delivery
  - paneer
  - biryani
  # ... 30-60 keywords
```

| Check | Result |
|---|---|
| Intent in `restricted_intents` | Blocked |
| Intent not in `allowed_intents` | Blocked |
| Intent is `"unknown"` | Blocked |

Blocked intents fall through to the next agent in the chain (support agent) rather than hard-blocking the customer.

### Gate 5 — Tool Executor

**File:** `runtime/executor.js`

Deterministic dispatch — no LLM involvement from this point.

1. Looks up the intent → tool mapping in the manifest:
   ```yaml
   intents:
     show_menu:
       tool: rag_menu
       auth_required: false
   ```

2. Looks up the tool config:
   ```yaml
   tools:
     rag_menu:
       type: rag
       db_path: "/path/to/orders.db"
       system_prompt: "You are a menu assistant..."
   ```

3. Dispatches to the tool type handler:

| Tool type | Handler | What it does |
|---|---|---|
| `rag` | `tools/ragTool.js` | Keyword search + vector DB → feeds results to LLM for natural language answer |
| `sqlite` | `tools/sqliteTool.js` | Order lookup by phone, UPI QR generation, invoice resend |
| `support` | `tools/supportTool.js` | FAQ keyword match → LLM with context → human escalation |
| `business_chat` | `tools/businessChatTool.js` | General conversation with business context |
| `order_create` | `tools/orderCreateTool.js` | Multi-turn cart/ordering flow |
| `static` | (inline) | Returns the manifest's `greet_message` or `help_message` |

### Agent Chain

Agents are chained in manifests. When an agent can't handle a message, it passes to the next:

```
restaurant-agent  →  show_menu / order_status / greet / help / place_order
        │
        ↓ unknown, restricted, or out of domain
        │
support-agent  →  FAQ match + LLM with session memory + order context
        │
        ↓ customer says "talk to human" or LLM fails
        │
Admin notified on WhatsApp — customer name, order history, full conversation thread
```

### Session Memory

**File:** `runtime/sessionMemory.js`

- 30-minute rolling window per phone number
- Follow-up messages carry full conversation context
- Short replies ("yes", "okay", "cancel it") stay with the agent that last responded
- Escalation only happens on explicit triggers ("talk to human", "manager")

---

## Admin Pipeline

The admin pipeline handles two modes: **query** (read-only SQL) and **agent** (full agentic loop with 35+ tools).

### Entry points

| Source | Auth | Route |
|---|---|---|
| API: `POST /setup/admin/run` | Session cookie | `handleAdmin(payload)` |
| WhatsApp: `ray <pin> <command>` | Phone number + keyword + PIN | `handleAdmin(payload)` |

### Mode routing

**File:** `gateway/admin.js` → `handleAdmin()`

```
Payload
  │
  ├── Starts with "approvals" ──► List pending approvals
  ├── Starts with "approve <id>" ──► Approve a blocked tool call
  ├── Starts with "agent " ──► Full agent loop (mode: agent)
  ├── Matches shell pattern ──► Direct shell execution
  └── Anything else ──► Dynamic SQL query (mode: query)
```

### Query Mode — Dynamic SQL Pipeline

```
Question ──► Governance check (query_db) ──► Schema extraction ──► LLM generates SQL ──► Execute (read-only) ──► LLM summarises ──► Response
```

**Step 1 — Governance:** Checks `authorizeToolCall({ tool: "query_db", role, worker })` before any SQL runs.

**Step 2 — Schema extraction:** `getDbSchema()` reads all table names, column types, and 2 sample rows from the database. This gives the LLM the actual structure and date formats.

**Step 3 — SQL generation:** Sends the schema + today's date (in both `YYYY-MM-DD` and `DD/MM/YYYY`) + the question to the LLM. Returns a raw `SELECT` query.

**Step 4 — Execution:** Runs the SQL against the database opened with `{ readonly: true }`. Only `SELECT` statements are executed — anything else triggers the fallback.

**Step 5 — Summarisation:** Sends the raw rows back to the LLM with the original question for a human-friendly answer.

**Fallback:** If SQL generation fails or execution throws, falls back to a pre-computed business summary (today's orders, month/year revenue, expenses, active orders).

### Agent Mode — Full Agentic Loop

**File:** `gateway/adminAgent.js` → `runAgentLoop()`

```
Task ──► Planner ──► Worker assignment ──► Tool calls (up to 20 turns) ──► Final answer
                                               │
                                               ↓
                                        Governance check on EVERY call
```

**Planner** (`gateway/adminPlanner.js`): A separate LLM call creates a 2-5 step plan, each step assigned to a worker.

**Workers** (`gateway/adminWorkers.js`): Labels that control tool access at each step:

| Worker | Role | Strengths |
|---|---|---|
| `planner` | Sequencing, choosing tools | Read-only tools, planning |
| `researcher` | Gathering facts | DB queries, file reading, browser inspection |
| `operator` | Executing actions | Shell, WhatsApp, browser clicks, order updates |
| `coder` | Writing code | File writes, npm install, script execution |

**Tool dispatch** (`dispatchTool()`): Every tool call passes through governance before execution:

```javascript
const decision = authorizeToolCall({ tool, worker, role, task, workspaceId })
if (!decision.allowed) {
    if (decision.requiresApproval) → create approval request, pause
    else → return blocked message
}
// Only reaches here if governance allows it
switch (name) {
    case "run_shell": ...
    case "query_db": ...
    // ... 35+ tools
}
```

**Self-healing:** If a tool fails or gets blocked, the LLM diagnoses the error and tries a different approach automatically (up to 20 turns).

### Available Admin Tools

| Category | Tools |
|---|---|
| Shell | `run_shell`, `mac_automation` |
| Database | `query_db` (SELECT only), `add_expense`, `update_order` |
| Messaging | `send_whatsapp` |
| Browser | `open_browser`, `navigate`, `screenshot`, `click`, `type_text`, `press_key`, `read_page`, `scrape_page`, `scroll`, `wait_for_element`, `get_current_url`, `close_browser`, `open_in_chrome`, `chrome_js` |
| Network | `http_request`, `load_test`, `recon`, `server_health` |
| Files | `write_file`, `read_file` |
| Code | `npm_install`, `run_node`, `run_skill` |
| Media | `youtube_play` |
| Meta | `list_tools`, `list_governance` |

---

## Governance System

**File:** `gateway/adminGovernance.js`  
**Config:** `data/workspaces/<id>/policy/admin-governance.json`

Every admin tool call passes through 4 authorization layers:

```
Tool registered? ──► Worker allowed? ──► Role allowed? ──► Risk + Approval?
```

### Layer 1 — Tool Registration

Every tool must be registered in the governance policy:

```json
{
  "tools": {
    "query_db": {
      "category": "data",
      "risk": "low",
      "mutating": false,
      "approval": "none",
      "roles": ["observer", "operator", "super_admin", "system_admin"]
    }
  }
}
```

If a tool isn't registered → **blocked**: `"Tool 'x' is not registered in governance policy."`

### Layer 2 — Worker Allowlist

Each worker can only use its assigned tools:

```json
{
  "workers": {
    "planner":    ["list_tools", "read_file", "query_db", "add_expense", "http_request", "server_health"],
    "researcher": ["list_tools", "read_file", "query_db", "http_request", "open_browser", "navigate", "..."],
    "operator":   ["list_tools", "query_db", "run_shell", "send_whatsapp", "update_order", "..."],
    "coder":      ["list_tools", "write_file", "npm_install", "run_node", "run_shell", "..."]
  }
}
```

If a researcher tries to call `send_whatsapp` → **blocked**: `"researcher is not allowed to use send_whatsapp."`

Exception: `system_admin` role bypasses worker restrictions.

### Layer 3 — Role Allowlist

Each tool declares which roles can use it:

```json
"query_db": { "roles": ["observer", "operator", "super_admin", "system_admin"] }
"run_shell": { "roles": ["operator", "super_admin", "system_admin"] }
```

If the caller's role isn't in the array → **blocked**: `"observer is not allowed to use run_shell."`

### Layer 4 — Risk Ceiling + Approval Mode

**Risk ceiling per role:**

```json
{
  "roles": {
    "observer":    { "maxRisk": "medium" },
    "operator":    { "maxRisk": "high" },
    "super_admin": { "maxRisk": "critical" },
    "system_admin": { "maxRisk": "critical" }
  }
}
```

**Risk levels:** `low` → `medium` → `high` → `critical`

If tool risk > role maxRisk → **blocked**: `"run_shell exceeds the risk limit for observer."`

**Approval modes:**

| Mode | Behavior |
|---|---|
| `"none"` | Auto-allowed if role and risk checks pass |
| `"explicit"` | Task text must contain approval language ("approved", "go ahead and...") or a valid approval token (`apr-xxx-xxx`) |
| `"task_intent"` | Only requires approval if the tool is `mutating` AND the task doesn't suggest mutation |

If approval is required but missing → **paused** (not permanently blocked):
```
⏸ Approval required for send_whatsapp.
Approval ID: apr-abc123-def456
Approve with: ray 1234 approve apr-abc123-def456
```

### Audit Trail

Every governance decision is logged to `data/workspaces/<id>/logs/governance.audit.log`:

```json
{"ts":"2026-03-20T10:15:42.123Z","event":"decision","tool":"query_db","role":"observer","allowed":true}
{"ts":"2026-03-20T10:16:01.456Z","event":"decision","tool":"run_shell","role":"observer","allowed":false,"reason":"observer is not allowed to use run_shell."}
```

Policy updates are also audited:
```json
{"ts":"2026-03-20T10:20:00.789Z","event":"policy_update","patch":{"tools":{"query_db":{"roles":["super_admin"]}}}}
```

---

## How to Give or Take Access

All changes via `POST /setup/governance/policy` or by editing `admin-governance.json` directly.

### Remove a role from a tool

```json
{
  "tools": {
    "query_db": {
      "category": "data", "risk": "low", "mutating": false,
      "approval": "none",
      "roles": ["super_admin", "system_admin"]
    }
  }
}
```
Now `observer` and `operator` cannot use `query_db`.

### Require approval for a tool

```json
{
  "tools": {
    "update_order": {
      "category": "data", "risk": "high", "mutating": true,
      "approval": "explicit",
      "roles": ["operator", "super_admin", "system_admin"]
    }
  }
}
```
Now `update_order` requires the admin to say "approved" or provide an approval token.

### Restrict a worker's tool access

```json
{
  "workers": {
    "researcher": ["list_tools", "read_file", "query_db", "http_request"]
  }
}
```
Now the researcher worker can only use those 4 tools — even if the role allows more.

### Add a new role

```json
{
  "roles": {
    "viewer": {
      "description": "Can only read data, no mutations.",
      "maxRisk": "low"
    }
  }
}
```
Then add `"viewer"` to the `roles` array of read-only tools.

### Raise risk level of a tool

```json
{
  "tools": {
    "query_db": {
      "category": "data", "risk": "high", "mutating": false,
      "approval": "explicit",
      "roles": ["super_admin", "system_admin"]
    }
  }
}
```
Now even reading the DB requires `super_admin` + explicit approval.

### Register a new tool

```json
{
  "tools": {
    "my_new_tool": {
      "category": "custom", "risk": "medium", "mutating": true,
      "approval": "task_intent",
      "roles": ["operator", "super_admin", "system_admin"]
    }
  },
  "workers": {
    "operator": ["list_tools", "query_db", "my_new_tool"]
  }
}
```

---

## Access Control Summary

| Layer | What it controls | Configured in | Applies to |
|---|---|---|---|
| Sanitizer | Blocks injection/malicious input | `gateway/sanitizer.js` (hardcoded) | Customer pipeline |
| Policy engine | Allowed/restricted intents, domain keywords | `policy/policy.yml` (per workspace) | Customer pipeline |
| Manifest | Intent → tool mapping, which tools exist | `agents/<slug>.yml` (per workspace) | Customer pipeline |
| Governance — tool registration | Tool must exist in policy | `admin-governance.json` → `tools` | Admin pipeline |
| Governance — worker allowlist | Which workers can use which tools | `admin-governance.json` → `workers` | Admin pipeline |
| Governance — role allowlist | Which roles can use which tools | `admin-governance.json` → `tools.*.roles` | Admin pipeline |
| Governance — risk ceiling | Max risk level per role | `admin-governance.json` → `roles.*.maxRisk` | Admin pipeline |
| Governance — approval mode | none / explicit / task_intent | `admin-governance.json` → `tools.*.approval` | Admin pipeline |

---

## Workspace Isolation

Each business workspace is fully isolated:

```
data/workspaces/<workspace-id>/
├── profile.json                    # Business profile (name, DB path, config)
├── policy/
│   └── admin-governance.json       # Governance rules (roles, workers, tools)
├── logs/
│   └── governance.audit.log        # Audit trail for this workspace
└── tmp/
    └── admin-approvals.json        # Pending approval requests

agents/<slug>.yml                   # Live agent manifest (intents, tools, messages)
agents/support/faq.yml              # Live FAQ knowledge base
policy/policy.yml                   # Live security policy (intent allowlist + domain keywords)
config/settings.json                # LLM provider, admin credentials, API secret
```

Workspaces share the same server process but each has:
- Its own agent manifest and intent routing
- Its own FAQ knowledge base
- Its own governance policy and audit log
- Its own database path
- Its own approval queue

---

## Request Flow Diagrams

### Customer message

```
WhatsApp message
    │
    ▼
Sanitizer ── blocked? ──► "Message could not be processed"
    │
    ▼
Active cart/support session? ── yes ──► Execute tool directly (skip classification)
    │ no
    ▼
Heuristic keyword match (no LLM)
    │
    ▼
LLM intent classification (manifest-driven)
    │
    ▼
Policy engine ── restricted? ──► Fall through to support agent
    │ allowed
    ▼
Manifest lookup: intent → tool name → tool config
    │
    ▼
Tool executor (deterministic, no LLM)
    │
    ▼
Response → WhatsApp
```

### Admin query mode

```
POST /setup/admin/run { mode: "query", task: "expenses today", role: "super_admin" }
    │
    ▼
Session cookie check ── invalid? ──► 401 setup_auth_required
    │
    ▼
Governance: authorizeToolCall({ tool: "query_db", role }) ── blocked? ──► "⛔ reason"
    │ allowed
    ▼
getDbSchema() → table names, columns, 2 sample rows
    │
    ▼
LLM generates SELECT query
    │
    ▼
Execute SQL (readonly: true) ── fails? ──► Fallback to pre-computed summary
    │
    ▼
LLM summarises rows into human-friendly answer
    │
    ▼
Response
```

### Admin agent mode

```
POST /setup/admin/run { mode: "agent", task: "mark ORD-123 as delivered", role: "super_admin" }
    │
    ▼
Session cookie check
    │
    ▼
Planner LLM call → 2-5 step plan, each assigned to a worker
    │
    ▼
┌─── Agent loop (up to 20 turns) ───┐
│                                     │
│  LLM picks a tool + arguments      │
│       │                             │
│       ▼                             │
│  authorizeToolCall()                │
│       │                             │
│       ├── blocked ──► LLM adapts    │
│       ├── needs approval ──► pause  │
│       └── allowed ──► execute tool  │
│                          │          │
│                          ▼          │
│                   Tool result       │
│                   fed back to LLM   │
│                          │          │
│                          ▼          │
│              More tools needed?     │
│                   │          │      │
│                  yes         no     │
│                   │          │      │
│              next turn    final     │
│                          answer    │
└─────────────────────────────────────┘
    │
    ▼
Response
```
