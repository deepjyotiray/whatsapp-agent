# whatsapp-agent

A self-hosted Secure Agent Runtime for WhatsApp — built for a home kitchen food business. Zero cloud dependency, zero per-message cost. Runs entirely on your own machine.

Agents are defined in YAML manifests. The runtime loads them, chains them, and enforces a secure pipeline on every message. The LLM is sandboxed by architecture — it classifies intent and formats responses. It never selects tools, accesses databases, or runs commands.

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

## Architecture

### Secure Pipeline

Every inbound message passes through these gates before anything executes:

```
Sanitizer → Domain Gate → Intent Parser (LLM) → Policy Engine → Manifest Resolver → Tool Executor
```

1. **Sanitizer** — 13 regex patterns blocking prompt injection, path traversal, command substitution, script tags. Max 500 chars
2. **Domain gate** — messages over 3 words must match domain keywords before the LLM is invoked
3. **Intent parser** — local Llama 3 via Ollama classifies the message into an intent. Translator only — never sees the database, never calls tools
4. **Policy engine** — YAML allowlist/blocklist. Restricted intents fall through to the next agent in the chain
5. **Manifest resolver** — looks up the intent in the agent manifest, resolves the tool
6. **Tool executor** — deterministic dispatch. No LLM from this point

### Agent Chain

Agents are chained in manifests. When an agent can't handle a message it passes to the next one. Each agent is more capable and more general than the one before it.

```
restaurant-agent  →  show_menu / order_status / greet / help
        ↓ unknown, restricted, or out of domain
support-agent  →  FAQ match + LLM with session memory + order context
        ↓ customer says "talk to human" or LLM fails
Admin notified on WhatsApp — name, orders, full conversation thread
```

Declared in the manifest:

```yaml
agent:
  chain:
    - agents/support.yml
```

### Session Memory

Every customer has a 30-minute rolling conversation window. Follow-up messages carry full context. Sessions expire after 30 minutes of inactivity. If a customer is mid-conversation with the support agent, short follow-up words ("Yes", "Okay", "Cancel it") skip the restaurant agent and go straight to support.

### Support Agent

Three-layer resolution:

1. **FAQ matching** — keyword-scored against `agents/support/faq.yml`. Fast, no LLM. Covers wrong orders, late delivery, refunds, allergies, bulk orders, payment issues, delivery area, timings
2. **LLM with context** — Llama 3 gets the FAQ knowledge + customer's actual order history from the DB + full conversation history
3. **Human escalation** — explicit triggers ("talk to human", "manager", "real person") or LLM failure → WhatsApp notification to admin with full context

## Stack

- **[Baileys](https://github.com/WhiskeySockets/Baileys)** — WhatsApp Web API, no official API needed
- **[Ollama](https://ollama.com) + Llama 3** — local LLM for intent parsing, RAG responses, support queries
- **[LanceDB](https://lancedb.com)** — local vector DB for menu RAG
- **SQLite (better-sqlite3)** — orders, menu, users, coupons, expenses
- **Node.js + pm2** — managed background process

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
  sanitizer.js          # Input sanitization
  intentParser.js       # LLM intent classifier
  policyEngine.js       # Allowlist/blocklist enforcement
  admin.js              # Admin channel — shell + NL business queries
  logger.js             # Pino logger

tools/
  ragTool.js            # Menu RAG via LanceDB + LLM responder
  sqliteTool.js         # Order lookup, invoice resend, QR generation
  supportTool.js        # FAQ match + LLM support + admin escalation
  buildQr.js            # Framed UPI QR image generator (Python/PIL)

transports/
  whatsapp.js           # Baileys transport — calls agentChain.execute()
  http.js               # HTTP transport — POST /message, GET /capabilities
  cli.js                # CLI REPL for local testing

transport/
  api.js                # Internal send API on port 3001 (used by tools to send media)

knowledge/
  rag.js                # SQLite keyword search + LanceDB fallback

policy/
  policy.yml            # Allowed/restricted intents + domain keywords

config/
  settings.example.json

vector.js               # Seeds LanceDB from orders.db
index.js                # Entry point
```

## Setup

```bash
git clone https://github.com/deepjyotiray/whatsapp-agent
cd whatsapp-agent
npm install

cp config/settings.example.json config/settings.json
# Edit config/settings.json — set api.secret, admin.number, admin.pin

# Seed the vector DB from your SQLite DB
node vector.js

# Start with WhatsApp transport (default)
node index.js --agent agents/restaurant.yml --transport whatsapp
# Scan the QR with WhatsApp to link the session

# Or test locally with CLI
node index.js --agent agents/restaurant.yml --transport cli
```

## Configuration

| Key | Description |
|-----|-------------|
| `ollama.url` | Ollama API endpoint (default: `http://localhost:11434/api/generate`) |
| `ollama.model` | Model name (default: `llama3`) |
| `api.port` | Internal send API port (default: `3001`) |
| `api.secret` | Shared secret for inter-service calls |
| `admin.number` | Your phone in international format e.g. `919XXXXXXXXX` |
| `admin.keyword` | Trigger keyword for admin channel |
| `admin.pin` | PIN required alongside the keyword |

## Adding a New Agent

Create a manifest file:

```yaml
agent:
  name: my-agent
  domain: my-domain
  skip_domain_gate: true   # optional — accept all messages

intents:
  my_intent:
    tool: my_tool
    auth_required: false

tools:
  my_tool:
    type: support   # rag | sqlite | support | static
    faq_path: ./agents/my-agent/faq.yml
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
```

## Security

- LLM is sandboxed — it only sees what the pipeline explicitly feeds it. It cannot select tools, access databases, or run commands
- Admin channel only works from one registered phone number + correct PIN
- Shell execution uses a command prefix allowlist
- All restricted intents escalate to the next agent — they are never hard-blocked from the customer's perspective
- WhatsApp session keys (`auth/`) are never committed
- All inter-service calls use a shared secret header (`x-secret`)

## License

All Rights Reserved. © Deepjyoti Ray

This source code is shared for reference and learning purposes only.
You may not use, copy, modify, or distribute this code for commercial purposes without explicit written permission.
