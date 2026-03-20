# whatsapp-agent

A self-hosted, plug-and-play AI agent runtime for WhatsApp. Built for a home kitchen food business — zero cloud dependency, zero per-message cost, runs entirely on your own machine.

Agents are defined in YAML manifests. The runtime loads them, chains them, and enforces a secure pipeline on every message. The LLM is sandboxed by architecture — it classifies intent and formats responses. It never selects tools, accesses databases, or runs commands.

All business logic — prompts, intents, tools, UPI handles, escalation contacts, FAQ — lives in the manifest. No code changes needed to deploy for a different business.

## What customers can do

- Browse the menu — veg/non-veg, prices, specific dishes, coupons
- Check active order status — delivery ETA, payment status
- Request invoice or payment QR — agent regenerates and resends the framed UPI QR image on demand
- Pay by sending a screenshot — agent detects it, marks order paid, sends receipt
- Get support — wrong order, late delivery, refund, allergy, bulk orders — handled by the support agent with full conversation context
- Escalate to a human — "talk to human" notifies the owner on WhatsApp with the customer's name, order history, and full conversation thread

## What the owner can do

From their own WhatsApp number with a keyword + PIN:

- Shell commands: `ray <pin> pm2 status`, `ray <pin> tail -n 50 logs/agent.log`
- Natural language business queries: `ray <pin> how much profit this month`, `ray <pin> which orders are unpaid`, `ray <pin> show today's orders`
- Mac automation: `ray <pin> set volume to 30`, `ray <pin> quit Chrome`, `ray <pin> show notification hello`
- Browser automation: `ray <pin> open youtube and play lo-fi music`, `ray <pin> search DuckDuckGo for X and summarise`
- Skills: `ray <pin> convert this text to speech`, `ray <pin> generate an image of a sunset`, `ray <pin> transcribe audio.mp3`
- Security: `ray <pin> recon https://mysite.com`, `ray <pin> load test https://mysite.com`

## How It Works — Plain English

### The Big Picture

You have a WhatsApp number that your customers message. Behind that number is a Node.js program running on your Mac. That program reads every incoming message and decides what to do with it.

There are two completely different worlds inside this program — the **customer world** and the **owner world**. The program figures out which world a message belongs to by looking at who sent it.

```
Incoming WhatsApp message
        ↓
Is it from the owner's phone?
   YES → Is it an image?
            YES → Vision LLM → parse JSON → insert into DB → reply
            NO  → Shell command / Agent loop / LLM answer
   NO  → Customer pipeline → Intent → Tool → Reply
```

---

### The Customer World

When a customer messages your WhatsApp, the message goes through a security pipeline before anything happens:

**Step 1 — Sanitizer**
Checks if the message looks like an attack. Things like `../../etc/passwd` or `<script>` get blocked immediately. Max 500 characters.

**Step 2 — Domain Gate**
If the message is more than 3 words, it must contain food-related keywords. Someone asking about cricket scores gets dropped here without ever touching the LLM.

**Step 3 — Intent Parser**
The LLM reads the message and classifies it into one intent from your `restaurant.yml` manifest — things like `show_menu`, `order_status`, `greet`. The LLM's only job here is to pick a label. It never touches your database or calls any tools.

**Step 4 — Policy Engine**
Checks if that intent is allowed or restricted.

**Step 5 — Tool Executor**
Looks up what tool is mapped to that intent in the manifest and runs it deterministically. No LLM involved from this point.

The two tools that handle most customer interactions:
- **RAG tool** — searches your menu using a vector database and answers questions like "do you have anything without onion"
- **SQLite tool** — looks up order status, generates UPI QR codes, resends invoices

If the customer asks something the restaurant agent can't handle, it passes to the **support agent** which does FAQ matching first, then LLM with full conversation context, then escalates to you on WhatsApp if needed.

---

### The Owner World

When a message comes from your phone number, the program skips the customer pipeline entirely.

#### Text messages

You send: `admin <pin> <something>`

The program strips the keyword and PIN, then looks at what's left:

- **Looks like a shell command** (`pm2 status`, `tail logs/agent.log`) → runs it directly on your Mac and sends back the output
- **Starts with `agent`** → hands it to the full AI agent loop (see below)
- **Anything else** → pulls a live snapshot of your business data from the DB (today's orders, this month's revenue, expenses, unpaid orders) and asks the LLM to answer your question using only that data. So "how much did I make today" just works.

#### Image messages

You send a photo — a receipt, a bill, a handwritten list of expenses.

The program takes that image and sends it directly to OpenAI's vision model with one instruction: *extract all expense entries from this image and return them as JSON*. It gets back something like:

```json
[
  {"heading": "Vegetables", "expense": 230, "date": "20/03/2026"},
  {"heading": "Gas", "expense": 180, "date": "20/03/2026"}
]
```

Then it inserts each row directly into your `expenses` table and replies with what was added. No agent, no approval, no tools — just vision → JSON → database.

#### The Agent Loop (for complex tasks)

When you send `admin <pin> agent <task>`, a much more powerful system kicks in. This handles things like "show me unpaid orders from last week", "restart the server", "open YouTube and play lo-fi", "recon my website".

How it works:

1. **Planner** — a separate LLM call creates a short plan: 2–5 steps, each assigned to a worker type
2. **Loop** — the main LLM sees the plan and starts calling tools, up to 20 turns
3. **Governance** — before every single tool call, the program checks a policy file. Each tool has a risk level and an approval requirement. A tool blocked by policy never runs — the LLM cannot override this
4. **Self-healing** — if a tool fails or gets blocked, the LLM diagnoses why and tries a different approach automatically

The workers are labels that control which tools are available at each step:
- `researcher` — read-only tools, DB queries, browser reading
- `operator` — shell commands, sending WhatsApp, updating orders, browser clicking
- `coder` — writing files, installing packages, running scripts

---

### The Database

Everything lives in one SQLite file on your Mac (`orders.db`). SQLite is just a single file that acts like a full database — no server needed.

Tables inside it:
- `orders` — every customer order ever placed, with status and payment info
- `expenses` — your manual expense and income entries
- `menu` — your food items and prices
- `users` — customer accounts
- `coupons` — discount codes

---

### The Workspace System

The agent supports multiple workspaces — separate business profiles, each with its own DB path and governance policy. The active workspace is stored in `data/active-workspace.json`. Every DB query and every tool call governance check reads from the active workspace's profile.

Current active workspace: `rays-home-kitchen`

---

### Key Design Principle

The LLM is only ever a classifier or a responder — it never directly touches your database or runs commands. All actual actions go through deterministic code. The governance policy file is the hard boundary that enforces this at runtime.

---

## Architecture

### Secure Pipeline

Every inbound message passes through these gates before anything executes:

```
Sanitizer → Domain Gate → Intent Parser (LLM) → Policy Engine → Manifest Resolver → Tool Executor
```

1. **Sanitizer** — 13 regex patterns blocking prompt injection, path traversal, command substitution, script tags. Max 500 chars
2. **Domain gate** — messages over 3 words must match domain keywords before the LLM is invoked
3. **Intent parser** — local LLM classifies the message into an intent from the manifest's `intents` list. Translator only — never sees the database, never calls tools
4. **Policy engine** — YAML allowlist/blocklist. Restricted intents fall through to the next agent in the chain rather than hard-blocking
5. **Manifest resolver** — looks up the intent in the agent manifest, resolves the tool and its config
6. **Tool executor** — deterministic dispatch. No LLM involvement from this point

### Agent Chain

Agents are chained in manifests. When an agent can't handle a message it passes to the next one.

```
restaurant-agent  →  show_menu / order_status / greet / help
        ↓ unknown, restricted, or out of domain
support-agent  →  FAQ match + LLM with session memory + order context
        ↓ customer says "talk to human" or LLM fails
Admin notified on WhatsApp — name, orders, full conversation thread
```

### Admin Agent Loop

The admin channel runs a full agentic loop (up to 20 turns) powered by `gpt-4o-mini`. The agent has access to 35+ tools and is self-healing — if a tool fails it diagnoses the error and retries with a different approach automatically.

```
Admin WhatsApp message → keyword + PIN check → runAgentLoop(task) → tool calls → final answer → WhatsApp reply
```

Tool categories available to the admin agent:

| Category | Tools |
|----------|-------|
| Shell | `run_shell` — pm2, tail, cat, ls, curl, node, npm, python3, pip3, uv |
| Database | `query_db` (SELECT only), `update_order` |
| Messaging | `send_whatsapp` |
| Mac | `mac_automation` (AppleScript + shell), `youtube_play` |
| Browser | `open_browser`, `navigate`, `snapshot`, `click`, `fill`, `type_text`, `press_key`, `read_page`, `scrape_page`, `scroll`, `wait_for_element`, `get_current_url`, `screenshot`, `close_browser` |
| Network | `http_request`, `load_test`, `recon` |
| Files | `write_file`, `read_file` |
| Code | `npm_install`, `run_node` |
| Skills | `run_skill` |
| Misc | `server_health`, `list_tools` |

### Browser Automation

Browser tools use a persistent Playwright session (`@playwright/cli`). The snapshot/ref API is used for all interactions — no CSS selectors, no index-based clicks.

```
open_browser → snapshot → click {ref} / fill {ref, text} → get_current_url → close_browser
```

### YouTube Playback

Playwright (headless) resolves the video URL from search results. Real Chrome (with login + autoplay) is opened via AppleScript. Spacebar triggers playback after a 3s wait.

```
open_browser (YouTube search) → sleep 4 → snapshot → click video ref → get_current_url → close_browser → youtube_play
```

### Skills Library

34 OpenClaw curated skills are bundled in `skills/`. Each skill has a `SKILL.md` with instructions and a `scripts/` directory with ready-to-run scripts. The `run_skill` tool loads the skill, copies scripts to `tmp/skills/<name>/`, and returns the exact CLI command to run.

Available skills:

`speech` · `transcribe` · `imagegen` · `sora` · `pdf` · `slides` · `doc` · `spreadsheet` · `screenshot` · `playwright` · `playwright-interactive` · `figma` · `figma-implement-design` · `sentry` · `gh-fix-ci` · `gh-address-comments` · `netlify-deploy` · `vercel-deploy` · `cloudflare-deploy` · `render-deploy` · `security-best-practices` · `security-threat-model` · `security-ownership-map` · `notion-knowledge-capture` · `notion-meeting-intelligence` · `notion-research-documentation` · `notion-spec-to-implementation` · `linear` · `yeet` · `chatgpt-apps` · `openai-docs` · `jupyter-notebook` · `develop-web-game` · `aspnet-core` · `winui-app`

Python skills run via `.venv/bin/python3` (project-root venv, `openai 2.28`). `OPENAI_API_KEY` is injected automatically from `settings.admin.agent_llm.api_key`.

### Intent Hints

Each manifest can declare `intent_hints` — plain-English descriptions of what each intent means. The intent parser reads these at runtime so the LLM understands the domain without any hardcoded prompts:

```yaml
intent_hints:
  show_menu: "customer asks about food, menu, items, prices, veg, non-veg, today's special"
  order_status: "customer asks about their order, delivery, payment, invoice, QR code"
```

### LLM Provider Switching

The runtime routes all LLM calls through `providers/llm.js`. Switch providers by changing one field in `settings.json`:

```json
{
  "llm": {
    "provider": "ollama",
    "url": "http://localhost:11434/api/generate",
    "model": "llama3"
  }
}
```

Supported providers: `ollama`, `openai`, `anthropic`

The admin agent uses a separate `admin.agent_llm` block (OpenAI only, supports tool calling):

```json
{
  "admin": {
    "agent_llm": {
      "provider": "openai",
      "url": "https://api.openai.com/v1/chat/completions",
      "model": "gpt-4o-mini",
      "api_key": "<your-openai-key>"
    }
  }
}
```

### Session Memory

Every customer has a 30-minute rolling conversation window. Follow-up messages carry full context. Short follow-up words ("Yes", "Okay", "Cancel it") are kept with the agent that last responded — they never jump to the next agent in the chain. Escalation only happens when the customer explicitly requests it ("talk to human", "manager", "real person") or the current agent cannot handle the message.

### Support Agent

Three-layer resolution:

1. **FAQ matching** — keyword-scored against `agents/support/faq.yml`. Fast, no LLM
2. **LLM with context** — gets the FAQ knowledge + customer's actual order history from the DB + full conversation history
3. **Human escalation** — explicit triggers ("talk to human", "manager", "real person") or LLM failure → WhatsApp notification to admin with full context

## Stack

- **[Baileys](https://github.com/WhiskeySockets/Baileys)** — WhatsApp Web API, no official API needed
- **[Ollama](https://ollama.com) + Llama 3** — local LLM for customer pipeline (or swap to OpenAI / Anthropic)
- **OpenAI gpt-4o-mini** — admin agent loop (tool calling)
- **[Playwright](https://playwright.dev)** — headless browser automation for admin tasks
- **[LanceDB](https://lancedb.com)** — local vector DB for menu RAG
- **SQLite (better-sqlite3)** — orders, menu, users, coupons, expenses
- **Node.js + pm2** — managed background process (`--max-old-space-size=512`)
- **Python 3 (.venv)** — skill scripts (speech, imagegen, transcribe, sora, etc.)

## Project Structure

```
agents/
  restaurant.yml        # Restaurant agent manifest
  support.yml           # Support agent manifest
  support/faq.yml       # Support knowledge base

runtime/
  agentChain.js         # Loads and runs the agent chain, owns the pipeline
  executor.js           # Manifest-driven tool dispatch
  sessionMemory.js      # 30-min per-phone conversation history

gateway/
  sanitizer.js          # Input sanitization (13 patterns)
  intentParser.js       # LLM intent classifier — generic, manifest-driven
  policyEngine.js       # Allowlist/blocklist enforcement
  adminAgent.js         # Admin agentic loop — 35+ tools, self-healing, 20-turn max
  logger.js             # Pino logger

providers/
  llm.js                # Provider router — reads settings.llm.provider
  ollama.js             # Ollama provider
  openai.js             # OpenAI provider
  anthropic.js          # Anthropic provider

tools/
  ragTool.js            # Menu RAG via LanceDB + LLM responder
  sqliteTool.js         # Order lookup, invoice resend, QR generation
  supportTool.js        # FAQ match + LLM support + admin escalation
  buildQr.js            # Framed UPI QR image generator (Python/PIL)
  computerTool.js       # Playwright browser automation (snapshot/ref API)

transports/
  whatsapp.js           # Baileys transport
  http.js               # HTTP transport — POST /message, GET /capabilities
  cli.js                # CLI REPL for local testing

transport/
  api.js                # Internal send API on port 3001 (used by tools to send media)

knowledge/
  rag.js                # SQLite keyword search + LanceDB fallback

policy/
  policy.yml            # Allowed/restricted intents + domain keywords

skills/                 # 34 OpenClaw curated skills
  speech/               # Text-to-speech (OpenAI TTS)
  transcribe/           # Audio transcription (OpenAI Whisper)
  imagegen/             # Image generation (DALL-E)
  sora/                 # Video generation (Sora)
  pdf/                  # PDF creation
  slides/               # Presentation generation
  doc/                  # Document generation
  spreadsheet/          # Spreadsheet generation
  screenshot/           # Web screenshot
  playwright/           # Browser automation skill
  figma/                # Figma integration
  sentry/               # Sentry error monitoring
  gh-fix-ci/            # GitHub CI fix
  gh-address-comments/  # GitHub PR comment resolution
  netlify-deploy/       # Netlify deployment
  vercel-deploy/        # Vercel deployment
  cloudflare-deploy/    # Cloudflare deployment
  render-deploy/        # Render deployment
  security-best-practices/
  security-threat-model/
  notion-*/             # Notion integrations (4 skills)
  linear/               # Linear issue management
  yeet/                 # Quick deploy
  ...                   # + more

.venv/                  # Python venv — openai 2.28, used by skill scripts
config/
  settings.example.json

index.js                # Entry point — --agent and --transport flags
```

## Setup

```bash
git clone https://github.com/deepjyotiray/whatsapp-agent
cd whatsapp-agent
npm install

cp config/settings.example.json config/settings.json
# Edit config/settings.json — set llm provider, api.secret, admin block

# Create Python venv for skill scripts
python3 -m venv .venv
.venv/bin/pip install openai

# Seed the vector DB from your SQLite DB
node seed.js --agent agents/restaurant.yml

# Start with WhatsApp transport (also starts the HTTP API on port 3010)
node index.js --agent agents/restaurant.yml --transport whatsapp
# Scan the QR with WhatsApp to link the session

# Or test locally with CLI
node index.js --agent agents/restaurant.yml --transport cli

# Or run with pm2 (recommended for production)
pm2 start index.js --name whatsapp-agent -- --agent agents/restaurant.yml --transport whatsapp
pm2 save
pm2 startup
```

## HTTP API

The HTTP server starts automatically alongside the WhatsApp transport on port `3010` (configurable via `settings.transports.http.port`).

Base URL: `http://127.0.0.1:3010`

### Authentication

Endpoints under `/message` and `/governance` require:
```
x-secret: <value of api.secret in settings.json>
```

Endpoints under `/setup/*` are open from localhost. When accessed from the configured `SETUP_HOST` domain they require a session cookie obtained via `POST /setup/login`.

---

### Customer pipeline

**Send a customer message**
```
POST /message
Header: x-secret: <api.secret>
Body:
{
  "phone": "919000000000",
  "message": "show me the menu"
}
```
The phone number determines routing. Any number that is not the admin number goes through the full customer pipeline — sanitizer → domain gate → intent → tool → response.

Response:
```json
{ "response": "Here's our menu for today..." }
```

---

### Admin — natural language query

**Ask a business question**
```
POST /setup/admin/run
Body:
{
  "mode": "query",
  "task": "how much did I make today"
}
```
Builds a live DB snapshot (orders, revenue, expenses) and asks the LLM to answer using only that data. Fast, no agent loop.

More examples:
```json
{ "mode": "query", "task": "which orders are unpaid" }
{ "mode": "query", "task": "how much profit this month" }
{ "mode": "query", "task": "show today's active orders" }
```

Response:
```json
{ "ok": true, "response": "Today's paid revenue is ₹2,340 across 6 orders.", "mode": "query" }
```

---

### Admin — agentic task

**Run a task with the full agent loop**
```
POST /setup/admin/run
Body:
{
  "mode": "agent",
  "task": "show unpaid orders from this week"
}
```
Spawns the full agentic loop — planner → tool calls → governance → self-healing → final answer. Use this for anything that needs tools: DB writes, shell commands, browser automation, etc.

More examples:
```json
{ "mode": "agent", "task": "pm2 status" }
{ "mode": "agent", "task": "mark order ORD-123 as delivered" }
{ "mode": "agent", "task": "recon https://healthymealspot.com" }
```

Response:
```json
{ "ok": true, "response": "Found 3 unpaid orders...", "mode": "agent" }
```

---

### Utility

**Health check**
```
GET /health
```
Response:
```json
{ "status": "ok", "agent": "restaurant-agent", "timestamp": "2026-03-20T08:52:42.498Z" }
```

**What the agent can handle**
```
GET /capabilities
```
Returns the loaded agent's intents, domain keywords, and chained agents.

**Governance snapshot**
```
GET /governance
Header: x-secret: <api.secret>
```
Returns the active workspace's full governance policy — roles, worker topology, tool risk levels.

**List pending approvals**
```
GET /governance/approvals
Header: x-secret: <api.secret>
```

**Approve a blocked tool call**
```
POST /setup/approvals/approve
Body:
{
  "id": "apr-xxxx-xxxx"
}
```

---

### Internal send API (port 3001)

Used by the agent's own tools to send WhatsApp messages and media back out. Not for external use, but useful for integration testing.

**Send a WhatsApp message**
```
POST http://127.0.0.1:3001/send
Header: x-secret: <api.secret>
Body:
{
  "phone": "+919000000000",
  "message": "hello from the API"
}
```

---

### Postman quick-start

1. Set a Postman environment variable `secret` = value of `api.secret` from your `settings.json`
2. Set `base_url` = `http://127.0.0.1:3010`
3. Import these as a collection:

| Name | Method | URL | Auth header | Body |
|------|--------|-----|-------------|------|
| Health | GET | `{{base_url}}/health` | — | — |
| Capabilities | GET | `{{base_url}}/capabilities` | — | — |
| Customer message | POST | `{{base_url}}/message` | `x-secret: {{secret}}` | `{"phone":"919000000000","message":"show me the menu"}` |
| Admin query | POST | `{{base_url}}/setup/admin/run` | — | `{"mode":"query","task":"how much did I make today"}` |
| Admin agent | POST | `{{base_url}}/setup/admin/run` | — | `{"mode":"agent","task":"show unpaid orders"}` |
| Governance | GET | `{{base_url}}/governance` | `x-secret: {{secret}}` | — |
| Approvals | GET | `{{base_url}}/governance/approvals` | `x-secret: {{secret}}` | — |
| Approve | POST | `{{base_url}}/setup/approvals/approve` | — | `{"id":"apr-xxxx-xxxx"}` |
| Internal send | POST | `http://127.0.0.1:3001/send` | `x-secret: {{secret}}` | `{"phone":"+919000000000","message":"test"}` |

## Configuration

### `settings.json`

| Key | Description |
|-----|-------------|
| `llm.provider` | `ollama` \| `openai` \| `anthropic` |
| `llm.url` | API endpoint (Ollama only) |
| `llm.model` | Model name |
| `llm.apiKey` | API key (OpenAI / Anthropic) |
| `api.port` | Internal send API port (default: `3001`) |
| `api.secret` | Shared secret for inter-service calls |
| `admin.number` | Your phone in international format e.g. `919XXXXXXXXX` |
| `admin.keyword` | Trigger keyword for admin channel |
| `admin.pin` | PIN required alongside the keyword |
| `admin.db_path` | Absolute path to your SQLite database |
| `admin.business_name` | Used in admin LLM prompts |
| `admin.agent_llm.model` | Model for admin agent loop (default: `gpt-4o-mini`) |
| `admin.agent_llm.api_key` | OpenAI key for admin agent + skill scripts |

### Agent Manifest Tool Config

All business-specific values live in the manifest, not in code:

```yaml
tools:
  order_lookup:
    type: sqlite
    db_path: "/path/to/orders.db"
    upi_handle: "XXXXXXXXXX@pthdfc"
    website: "yourdomain.com"
    brand_label: "yourdomain.com"
    country_code: "91"

  rag_menu:
    type: rag
    db_path: "/path/to/orders.db"
    vectordb_path: "./vectordb"
    system_prompt: |
      You are a helpful assistant for <Business Name>...

  support_faq:
    type: support
    faq_path: "./agents/support/faq.yml"
    db_path: "/path/to/orders.db"
    business_name: "Your Business Name"
    escalation_phone: "+91XXXXXXXXXX"
```

## Adding a New Agent

Create a manifest:

```yaml
agent:
  name: my-agent
  domain: my-domain
  skip_domain_gate: true   # optional — accept all messages

intent_hints:
  my_intent: "describe when this intent should trigger"

intents:
  my_intent:
    tool: my_tool
    auth_required: false

tools:
  my_tool:
    type: support   # rag | sqlite | support | static
    faq_path: ./agents/my-agent/faq.yml
    business_name: "My Business"
    escalation_phone: "+91XXXXXXXXXX"
```

Add it to the chain of an existing agent:

```yaml
agent:
  chain:
    - agents/my-agent.yml
```

No code changes required.

## Admin Channel

```
<keyword> <pin> pm2 list
<keyword> <pin> pm2 restart whatsapp-agent
<keyword> <pin> tail -n 50 logs/agent.log
<keyword> <pin> how much profit this month
<keyword> <pin> which orders are unpaid
<keyword> <pin> show today's active orders
<keyword> <pin> overall revenue this year
<keyword> <pin> set volume to 30
<keyword> <pin> open youtube and play lo-fi beats
<keyword> <pin> recon https://mysite.com
<keyword> <pin> load test https://mysite.com 50 requests
<keyword> <pin> convert "hello world" to speech and send it
<keyword> <pin> generate an image of a mountain at sunset
```

## Security

- LLM is sandboxed — it only sees what the pipeline explicitly feeds it. It cannot select tools, access databases, or run commands
- Admin channel only works from one registered phone number + correct PIN
- Shell execution uses a command prefix allowlist
- Restricted intents fall through to the next agent — never hard-blocked from the customer's perspective
- WhatsApp session keys (`auth/`) are never committed
- All inter-service calls use a shared secret header (`x-secret`)
- No business data (DB path, UPI handle, phone numbers) is hardcoded in runtime code
- `tmp/`, `out/`, `.playwright-cli/` are gitignored — no runtime artifacts committed

## License

All Rights Reserved. © Deepjyoti Ray

This source code is shared for reference and learning purposes only.
You may not use, copy, modify, or distribute this code for commercial purposes without explicit written permission.
