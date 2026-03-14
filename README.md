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

# Start with WhatsApp transport
node index.js --agent agents/restaurant.yml --transport whatsapp
# Scan the QR with WhatsApp to link the session

# Or test locally with CLI
node index.js --agent agents/restaurant.yml --transport cli
```

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
