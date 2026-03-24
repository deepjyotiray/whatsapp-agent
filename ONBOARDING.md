# Setting Up Your Restaurant on the Secure Agent

This guide walks you through setting up a restaurant business from scratch on the secure-agent platform. By the end, you'll have a WhatsApp bot that can show your menu, take orders, look up order status, handle support, and let you run admin queries — all through WhatsApp.

---

## What You're Setting Up

Three servers work together:

```
┌─────────────────────────────────────────────────────────────────┐
│                        YOUR RESTAURANT                          │
│                                                                 │
│  ray-orders-backend (:3000)     secure-agent (:3001 + :3010)    │
│  ┌──────────────────────┐      ┌────────────────────────────┐   │
│  │ SQLite DB (orders,   │◄────►│ WhatsApp bot (Baileys)     │   │
│  │ menu, users, coupons)│      │ AI intent classification   │   │
│  │ Admin panel (/admin) │      │ Menu RAG, order flow,      │   │
│  │ Order CRUD API       │      │ support escalation         │   │
│  │ Invoice/receipt gen  │      │ Admin agent (35+ tools)    │   │
│  └──────────────────────┘      │ Control Panel UI           │   │
│                                └────────────────────────────┘   │
│                                         │                       │
│                                    WhatsApp Cloud               │
│                                    (Baileys P2P)                │
└─────────────────────────────────────────────────────────────────┘
```

- **ray-orders-backend** — your database, menu management, order processing, admin panel
- **secure-agent** — the AI brain: WhatsApp connection, intent routing, menu search, ordering flow, support, admin agent

The secure-agent reads from the same SQLite database that the orders backend writes to.

---

## Prerequisites

- Node.js 18+
- An OpenAI API key (for intent classification and chat responses)
- A WhatsApp account (you'll scan a QR code to link it)
- The orders backend already has menu data in its SQLite DB

---

## Step 1 — Set Up the Orders Backend

```bash
cd ray-orders-backend
```

Create `.env`:
```env
SESSION_SECRET=<generate: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
ADMIN_API_KEY=<generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
WHATSAPP_AGENT_SECRET=<pick a strong secret — you'll reuse this in the agent>
```

Optional `.env` vars:
```env
EMAIL_USER=your-email@gmail.com          # for order email notifications
EMAIL_PASS=your-app-password             # Gmail app password
ORDER_EMAIL_RECIPIENTS=you@email.com     # comma-separated
```

Install and start:
```bash
npm install
node server.js
# → 🚀 Order backend running on http://localhost:3000
```

Verify:
```bash
curl http://localhost:3000/menu?type=main | head -c 200
# Should return JSON with your menu sections
```

If the menu is empty, load it through the admin panel at `http://localhost:3000/admin`.

---

## Step 2 — Configure the Secure Agent

```bash
cd secure-agent
npm install
```

### 2a — config/settings.json

This file is gitignored. Create it with your real values:

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "api_key": "<your-openai-api-key>"
  },
  "otp": {
    "ttlSeconds": 300
  },
  "log": {
    "level": "info"
  },
  "api": {
    "port": 3001,
    "secret": "<same WHATSAPP_AGENT_SECRET from Step 1>"
  },
  "admin": {
    "number": "91XXXXXXXXXX",
    "keyword": "admin",
    "pin": "<pick a 4-6 digit PIN>",
    "users": [
      { "phone": "91XXXXXXXXXX", "name": "Owner", "role": "super_admin", "mode": "full", "pin": "<your-pin>" }
    ],
    "shell_patterns": ["pm2", "tail", "cat", "ls", "df", "du", "uptime", "node", "npm", "kill", "ping"],
    "db_path": "<absolute path to ray-orders-backend/orders.db>",
    "business_name": "Healthy Meal Spot",
    "agent_llm": {
      "model": "gpt-4o-mini",
      "api_key": "<your-openai-api-key>"
    }
  }
}
```

| Field | What to put |
|---|---|
| `llm.api_key` | Your OpenAI API key (starts with `sk-`) |
| `api.secret` | **Must match** the `WHATSAPP_AGENT_SECRET` in the orders backend `.env` |
| `admin.number` | Fallback admin phone with country code, no `+` (e.g. `919326492088`) |
| `admin.pin` | Fallback PIN (used if `admin.users` is empty) |
| `admin.users` | Array of admin users — each with `phone`, `name`, `role`, `mode`, `pin`. Add more users later via the Setup UI (Tools → Admin Users) |
| `admin.shell_patterns` | Allowed shell command prefixes. Add more via the Setup UI (Tools → Admin Shell Commands) |
| `admin.db_path` | Absolute path to `orders.db` (e.g. `/Users/you/ray-orders-backend/orders.db`) |

### 2b — Link the database

The agent manifest references `./data/orders.db`. Create a symlink so the agent can read the same database the backend writes to:

```bash
cd secure-agent
mkdir -p data
ln -sf /absolute/path/to/ray-orders-backend/orders.db data/orders.db
```

Verify:
```bash
ls -la data/orders.db
# Should show a symlink pointing to the real orders.db
```

### 2c — agents/restaurant.yml

Update the placeholder values in the manifest. The file is already structured — you only need to change these fields:

```yaml
tools:
  order_lookup:
    upi_handle: "your-upi-id@bank"        # your real UPI handle for QR codes
    website: "healthymealspot.com"          # your domain
    brand_label: "healthymealspot.com"      # shown on QR code
    country_code: "91"

  support_faq:
    escalation_phone: "+919326492088"       # your WhatsApp number for escalations
```

Everything else (`db_path`, `backend_url`, tool types, intents) is already correct.

### 2d — Verify the policy

The file `policy/policy.yml` controls which intents customers can trigger. It should already contain:

```yaml
allowed_intents:
  - greet
  - help
  - show_menu
  - order_status
  - place_order
  - general_chat
  - support
```

If it doesn't, update it. Any intent not in this list gets blocked for customers.

---

## Step 3 — Start the Agent

```bash
cd secure-agent
node index.js --agent agents/restaurant.yml
```

**First time?** You'll see a QR code in the terminal. Scan it with WhatsApp (Settings → Linked Devices → Link a Device). The session is saved in `auth/` — you won't need to scan again unless you log out.

**Already linked?** It connects automatically:
```
WhatsApp connected
http transport listening on port 3010
whatsapp-agent API listening on port 3001
```

Verify:
```bash
curl http://127.0.0.1:3010/health
# → {"status":"ok","agent":"restaurant-agent","timestamp":"..."}

curl http://127.0.0.1:3010/capabilities
# → {"agent":"restaurant-agent","intents":["greet","general_chat","show_menu",...],"tools":["concierge","rag_menu",...]}
```

---

## Step 4 — Test via WhatsApp

Send these messages from **any phone** (not the linked one) to the WhatsApp number:

| Test | Message | Expected |
|---|---|---|
| Greeting | `hi` | Warm welcome from Healthy Meal Spot |
| Menu browse | `show me veg items` | List of vegetarian dishes with prices |
| Nutrition filter | `high protein meals` | Filtered menu items |
| Coupon check | `any offers?` | Active coupons list |
| Place order | `I want to order` | Multi-step ordering flow starts |
| Order status | `where is my order` | Shows active orders (or "not registered" if new) |
| Support | `I have a complaint` | Support menu (5 options) |
| Out of domain | `what's the weather` | Redirected back to food topics |

### Test admin mode

From the **admin phone** (any number registered in `settings.json → admin.users`), send:

```
admin <your-pin> show today's orders
```

The admin agent will query the database and respond with a summary.

To add more admin users later, use the Setup UI at `http://localhost:3010/tools` → Admin Users section.

---

## Step 5 — Verify the Full Flow

### How Customer Messages Actually Work

For a layman, the easiest way to think about the customer flow is:

`message` → `intent router` → `tool`

The system does **not** send every customer message to the LLM.

Instead:

1. The router tries fast heuristics first.
   Examples:
   - `hi` → greeting
   - `my open orders` → order lookup
   - `i need help` → support

2. If heuristics are not enough, the intent parser LLM chooses the intent.

3. The selected tool decides how to answer:
   - **Direct DB / session tools**: `order_lookup`, `order_create`
   - **Grounded retrieval tools**: `rag_menu`, `policy_rag`
   - **LLM-backed tools**: `concierge`, support-info answers

Examples:

- `My open orders`
  → `order_lookup`
  → direct database lookup
  → no LLM needed

- `High protein dishes`
  → `rag_menu`
  → grounded menu retrieval
  → returns from menu data

- `Open hours`
  → `concierge`
  → tries the configured customer backend first
  → if that backend returns nothing, falls back to the saved business profile

- `What is your support email`
  → support intent
  → first checks for profile-backed support info
  → only opens the complaint menu for actual complaint-style issues

### Order placement flow (WhatsApp)

1. Customer sends: `I want to order`
2. Agent shows menu sections (numbered)
3. Customer picks a section number
4. Agent shows items in that section
5. Customer picks an item number
6. Agent asks for quantity
7. Customer can add more or checkout
8. Agent asks for delivery time
9. Customer confirms → order is created in the database
10. Customer gets order confirmation
11. Kitchen admin gets WhatsApp notification

### Order status flow

1. Customer sends: `order status`
2. Agent looks up pending orders by phone number
3. Shows delivery status, payment status, ETA

### Invoice resend flow

1. Customer sends: `resend my invoice`
2. Agent finds the order, generates UPI QR code, sends invoice + QR via WhatsApp

---

## Step 6 — Access the Control Panel (Optional)

The secure-agent includes a web-based control panel for testing and managing the AI:

```
http://localhost:3010/control
```

Login: `linkedin` / `community` (configured in `transports/http.js`)

From here you can:
- Preview what the agent will do before it executes (Preview → Approve → Execute)
- Set execution policies (auto-execute low-risk, require approval for high-risk)
- Save multi-step plans as reusable workflows
- Test messages without sending them through WhatsApp

---

## Architecture Quick Reference

### Customer message flow

```
WhatsApp message
    → Sanitizer (72 patterns, blocks injection/XSS/SQL)
    → Session check (active cart? active support? → skip LLM)
    → Intent classification (heuristic + LLM)
    → Policy engine (allowed_intents check)
    → Tool executor (deterministic dispatch)
    → Response sent via WhatsApp
```

### What each tool does

| Tool | Type | Handles |
|---|---|---|
| `concierge` | `business_chat` | Greetings, general chat, recommendations |
| `rag_menu` | `menu_rag` | Menu search with nutrition/price/veg filters |
| `order_create` | `order_create` | Multi-turn ordering flow (browse → cart → checkout) |
| `order_lookup` | `order_lookup` | Order status, invoice resend, UPI QR generation |
| `support_faq` | `restaurant_support` | Complaint handling, escalation to admin |

### Ports

| Port | Service | Purpose |
|---|---|---|
| 3000 | ray-orders-backend | Database, admin panel, order API |
| 3001 | secure-agent (WhatsApp API) | Outbound WhatsApp messages (`POST /send`) |
| 3010 | secure-agent (HTTP console) | Control panel, setup UI, preview engine |

### Key files

| File | Purpose |
|---|---|
| `agents/restaurant.yml` | Agent manifest — intents, tools, messages |
| `config/settings.json` | LLM keys, admin config, API secret |
| `policy/policy.yml` | Allowed intents + domain keywords |
| `data/orders.db` | Symlink to the real database |
| `auth/` | WhatsApp session (auto-created on first QR scan) |
| `domain-packs/restaurant/` | Restaurant-specific tool handlers |

---

## Troubleshooting

### "AgentChain: call loadAgent() first"
You forgot `--agent agents/restaurant.yml` when starting the server.

### Agent responds but menu is empty
The `data/orders.db` symlink is broken or points to a DB with no menu data. Verify:
```bash
ls -la data/orders.db
sqlite3 data/orders.db "SELECT COUNT(*) FROM menu_items"
```

### "whatsapp not connected" on /send
The WhatsApp session expired or was never created. Delete `auth/` and restart to get a fresh QR code:
```bash
rm -rf auth/
node index.js --agent agents/restaurant.yml
# Scan the QR code
```

### Customer messages are blocked
Check `policy/policy.yml` — the intent must be in `allowed_intents`. Also check that `domain_keywords` includes words the customer might use.

### Admin commands don't work
- Verify the phone number is registered in `admin.users` array in `config/settings.json` (format: `91XXXXXXXXXX`, no `+`)
- Message format: `admin <pin> <your command>` — the PIN must match the user's `pin` field
- If `admin.users` is empty, falls back to `admin.number` + `admin.pin`
- Check the user's `mode` — `query_only` users can't run shell or agent commands

### Orders aren't created
- Check that `order_create.backend_url` in `restaurant.yml` points to the running orders backend (`http://localhost:3000`)
- Check that the orders backend's `WHATSAPP_AGENT_SECRET` matches `api.secret` in `config/settings.json`

### Invoice QR codes fail
- Check that `order_lookup.upi_handle` in `restaurant.yml` is your real UPI ID
- The `buildQr` tool requires Python 3 with PIL/Pillow installed:
  ```bash
  pip3 install Pillow
  ```

---

## Checklist

Before going live, verify every item:

- [ ] `ray-orders-backend` is running on `:3000` with menu data loaded
- [ ] `config/settings.json` has real OpenAI API key
- [ ] `config/settings.json` → `api.secret` matches orders backend `WHATSAPP_AGENT_SECRET`
- [ ] `config/settings.json` → `admin.users` has at least one user with your WhatsApp number
- [ ] `config/settings.json` → `admin.db_path` is the absolute path to `orders.db`
- [ ] `data/orders.db` symlink exists and points to the real database
- [ ] `agents/restaurant.yml` → `upi_handle` is your real UPI ID
- [ ] `agents/restaurant.yml` → `website` is your real domain
- [ ] `agents/restaurant.yml` → `escalation_phone` is your real phone
- [ ] `policy/policy.yml` has all 7 intents in `allowed_intents`
- [ ] WhatsApp QR scanned and session saved in `auth/`
- [ ] Tested: greeting, menu, order, status, support from a non-admin phone
- [ ] Tested: admin query from the admin phone
- [ ] Python 3 + Pillow installed (for invoice QR codes)
