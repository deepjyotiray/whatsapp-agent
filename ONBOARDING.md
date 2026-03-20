# Onboarding a New Business

This guide walks through onboarding a new business onto the secure-agent platform. Each business gets its own isolated workspace with a dedicated agent manifest, FAQ, governance policy, and database.

## Prerequisites

- The secure-agent server is running (`node index.js`)
- An OpenAI API key for agent generation
- A SQLite database for the business (or let the generator create one)

## Step 1 — Login

Get a session cookie. All `/setup/*` endpoints require it.

```
POST /setup/login
{
  "username": "linkedin",
  "password": "community"
}
```

Response sets a `secureai_session` cookie (12h TTL). Postman stores it automatically.

## Step 2 — Save the business profile

```
POST /setup/profile
{
  "businessName": "Bloom Flower Shop",
  "businessType": "flower delivery",
  "brandVoice": "cheerful and helpful",
  "website": "https://bloomflowers.com",
  "countryCode": "91",
  "currency": "₹",
  "contactPhone": "+919000000000",
  "offerings": "bouquets, single stems, event arrangements, subscriptions",
  "fulfillmentMode": "delivery and pickup",
  "faqSeed": "delivery time, wilting policy, custom arrangements",
  "supportPolicy": "refund within 24h if flowers arrive damaged",
  "adminPhone": "919000000000",
  "adminPin": "1234",
  "openaiKey": "<your-openai-key>",
  "dbPath": "/path/to/bloom.db",
  "escalationPhone": "+919000000000",
  "workspaceId": "bloom-flower-shop"
}
```

This creates:
- `data/workspaces/bloom-flower-shop/profile.json`
- Sets `bloom-flower-shop` as the active workspace

### Profile fields

| Field | Purpose |
|---|---|
| `businessName` | Used in agent prompts, FAQ, and greetings |
| `businessType` | Helps the generator understand the domain |
| `brandVoice` | Tone of the agent's responses |
| `website` | Scraped during generation for additional context |
| `offerings` | Products/services — drives intent and tool generation |
| `faqSeed` | Comma-separated topics to seed the FAQ knowledge base |
| `supportPolicy` | Refund/complaint handling rules baked into the support agent |
| `adminPhone` | Phone number that gets admin access via WhatsApp |
| `adminPin` | PIN required alongside the admin keyword |
| `openaiKey` | Used for generation and the admin agent loop |
| `dbPath` | Absolute path to the business's SQLite database |
| `escalationPhone` | Where human escalations are sent |
| `scrapeWebsite` | `true` (default) — scrapes the website for extra context during generation |

## Step 3 — Generate the agent draft

```
POST /setup/generate
{ ...same profile body as Step 2... }
```

This runs **4 parallel GPT-4o calls** that produce:

| File | What it contains |
|---|---|
| `agents/<slug>.yml` | Agent manifest — intents, tools, greet/help/error messages, intent hints |
| `agents/support/faq.yml` | 10-15 FAQs with keyword matching + escalation triggers |
| `policy/policy.yml` | Allowed/restricted intents + 30-60 domain keywords |
| `db/schema.sql` | CREATE TABLE statements for the business |
| `db/seed.js` | Sample data seeder script |
| `config/settings.json` | LLM config, admin credentials, API secret |

All files land in `draft/workspaces/bloom-flower-shop/` — **not live yet**.

Response:
```json
{
  "ok": true,
  "slug": "bloom-flower-shop",
  "workspaceId": "bloom-flower-shop",
  "draftFiles": ["draft/workspaces/bloom-flower-shop/agents/bloom-flower-shop.yml", "..."],
  "intents": ["greet", "help", "show_catalogue", "order_status", "support"],
  "faqTopics": ["delivery_time", "wilting_policy", "custom_arrangements", "..."],
  "keywordCount": 42
}
```

## Step 4 — Test the draft

```
POST /setup/chat
{
  "phone": "919000000000",
  "message": "hi",
  "workspaceId": "bloom-flower-shop"
}
```

Response:
```json
{
  "ok": true,
  "response": "Welcome to Bloom Flower Shop! 🌸 ...",
  "source": "draft"
}
```

`source: "draft"` confirms it's hitting the draft agent. If no draft exists, it falls through to the live agent and returns `source: "live"`.

Test multiple scenarios:
- Greeting: `"hi"`
- Catalogue: `"show me bouquets under 500"`
- Order status: `"where is my order"`
- Support: `"my flowers arrived wilted"`
- Out of domain: `"what's the weather"`

## Step 5 — Promote to live

```
POST /setup/promote
{ "workspaceId": "bloom-flower-shop" }
```

Copies all draft files to the live agent config directory. The agent reloads on the next request.

Response:
```json
{
  "ok": true,
  "promoted": 6,
  "files": ["agents/bloom-flower-shop.yml", "agents/support/faq.yml", "policy/policy.yml", "..."]
}
```

## Step 6 — Configure governance

Set tool access policies for this workspace:

```
POST /setup/governance/policy
{
  "workspaceId": "bloom-flower-shop",
  "tools": {
    "query_db": {
      "category": "data",
      "risk": "low",
      "mutating": false,
      "approval": "none",
      "roles": ["super_admin", "system_admin"]
    },
    "send_whatsapp": {
      "category": "communication",
      "risk": "high",
      "mutating": true,
      "approval": "explicit",
      "roles": ["super_admin", "system_admin"]
    }
  }
}
```

This creates `data/workspaces/bloom-flower-shop/policy/admin-governance.json`.

## Step 7 — Switch between businesses

**Option A — Switch globally:**
```
POST /setup/workspace/select
{ "workspaceId": "bloom-flower-shop" }
```
All subsequent requests without an explicit `workspaceId` use this workspace.

**Option B — Per-request targeting:**
```
POST /setup/admin/run
{
  "mode": "query",
  "task": "show today's orders",
  "workspaceId": "bloom-flower-shop"
}
```

**List all workspaces:**
```
GET /setup/workspaces
```
Returns:
```json
{
  "workspaces": ["bloom-flower-shop", "rays-home-kitchen", "default"],
  "active": "bloom-flower-shop"
}
```

## Step 8 — Verify the profile

```
GET /setup/profile?workspace=bloom-flower-shop
```

Returns the full profile, draft file list, and workspace summary.

## What each workspace gets

```
data/workspaces/bloom-flower-shop/
├── profile.json                    # Business profile
├── policy/
│   └── admin-governance.json       # Governance rules (roles, workers, tools)
├── logs/
│   └── governance.audit.log        # Audit trail
└── tmp/
    └── admin-approvals.json        # Pending approval requests

agents/bloom-flower-shop.yml        # Live agent manifest
agents/support/faq.yml              # Live FAQ knowledge base
policy/policy.yml                   # Live security policy (intents + domain keywords)
config/settings.json                # LLM + admin config
```

## Quick reference — all onboarding APIs

| Step | Method | Endpoint | Purpose |
|------|--------|----------|---------|
| Auth | POST | `/setup/login` | Get session cookie |
| Profile | GET | `/setup/profile?workspace=<id>` | Load profile |
| Profile | POST | `/setup/profile` | Save profile |
| Generate | POST | `/setup/generate` | Generate agent draft |
| Test | POST | `/setup/chat` | Test draft/live agent |
| Promote | POST | `/setup/promote` | Promote draft to live |
| Governance | POST | `/setup/governance/policy` | Update tool access |
| Governance | GET | `/setup/governance` | View governance snapshot |
| Workspaces | GET | `/setup/workspaces` | List all workspaces |
| Workspaces | POST | `/setup/workspace/select` | Switch active workspace |
| Workers | GET | `/setup/workers` | List agent workers |
| Auth | POST | `/setup/logout` | Clear session |
