# whatsapp-agent

A self-hosted, policy-gated AI agent for WhatsApp — built for a home kitchen food business. Zero cloud dependency, zero per-message cost. Runs entirely on your own machine.

## What it does

Customers can message your WhatsApp number and:
- Browse the menu, ask about veg/non-veg dishes, prices, specific items
- Check their active order status (delivery + payment)
- Request their invoice or payment QR — agent regenerates and resends it
- Pay by sending a screenshot — agent detects it, marks order paid, sends receipt
- Login with OTP

The business owner gets a private admin channel:
- Run shell commands: `ray <pin> pm2 status`
- Ask natural language business questions: `ray <pin> how much profit this month`

## Architecture

Every inbound message passes through a 6-step secure pipeline:

```
Sanitizer → OTP Intercept → Domain Check → Intent Parser (LLM) → Policy Engine → Executor
```

1. **Sanitizer** — 13 regex patterns, blocks injections, max 500 chars
2. **OTP intercept** — 6-digit codes routed directly to auth, LLM never sees them
3. **Domain confinement** — messages over 3 words must match food/order keywords before touching the LLM
4. **Intent parser** — local Llama 3 via Ollama classifies intent. Acts as a translator only — never calls tools or accesses data
5. **Policy engine** — YAML allowlist/blocklist, restricted intents rejected before execution
6. **Executor** — deterministic tool dispatch, no LLM involved

## Stack

- **[Baileys](https://github.com/WhiskeySockets/Baileys)** — WhatsApp Web API (no official API needed)
- **[Ollama](https://ollama.com) + Llama 3** — local LLM for intent parsing and RAG responses
- **[LanceDB](https://lancedb.com)** — local vector DB for menu/RAG search
- **SQLite (better-sqlite3)** — orders, menu, users, coupons, expenses
- **Node.js + pm2** — runs as a managed background process

## Setup

```bash
git clone https://github.com/deepjyotiray/whatsapp-agent
cd whatsapp-agent
npm install

cp config/settings.example.json config/settings.json
# Edit config/settings.json with your values

# Seed the vector DB from your orders.db
node vector.js

# Start
node index.js
# Scan the QR with WhatsApp to link the session
```

## Configuration

Copy `config/settings.example.json` to `config/settings.json` and fill in:

| Key | Description |
|-----|-------------|
| `ollama.url` | Ollama API endpoint (default: `http://localhost:11434/api/generate`) |
| `ollama.model` | Model name (default: `llama3`) |
| `api.port` | Internal HTTP API port (default: `3001`) |
| `api.secret` | Shared secret for inter-service calls |
| `admin.number` | Your phone number in international format e.g. `919XXXXXXXXX` |
| `admin.keyword` | Trigger keyword for admin commands |
| `admin.pin` | PIN required alongside the keyword |

## Admin commands

From your registered admin number:

```
<keyword> <pin> pm2 list
<keyword> <pin> pm2 restart whatsapp-agent
<keyword> <pin> tail -n 50 logs/agent.log
<keyword> <pin> how much profit this month
<keyword> <pin> which orders are unpaid
<keyword> <pin> show today's active orders
```

## Policy

Edit `policy/policy.yml` to control allowed intents and domain keywords:

```yaml
allowed_intents:
  - show_menu
  - help
  - greet
  - login
  - order_status

restricted_intents:
  - create_order
  - cancel_order
```

## Project structure

```
gateway/        # Pipeline steps: sanitizer, intent parser, policy engine, executor, admin
tools/          # Tool handlers: menu, order status, auth, QR builder
transport/      # Baileys WhatsApp transport + internal HTTP API
knowledge/      # RAG retrieval from SQLite
policy/         # policy.yml
config/         # settings.example.json
vector.js       # Seeds LanceDB from orders.db
index.js        # Entry point
```

## Security notes

- The LLM is sandboxed — it only sees what the pipeline explicitly feeds it
- Admin commands only work from one specific phone number + correct PIN
- Shell execution uses a command prefix allowlist
- WhatsApp session keys (`auth/`) are never committed
- All inter-service calls use a shared secret header

## License

MIT
