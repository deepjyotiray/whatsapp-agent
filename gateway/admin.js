"use strict"

const { exec } = require("child_process")
const Database = require("better-sqlite3")
const settings = require("../config/settings.json")
const { complete } = require("../providers/llm")
const { runAgentLoop } = require("./adminAgent")
const { approveRequest, listApprovals } = require("./adminApprovals")
const { authorizeToolCall } = require("./adminGovernance")
const { getActiveWorkspace } = require("../core/workspace")
const { loadProfile } = require("../setup/profileService")
const logger = require("./logger")

const DB_PATH = settings.admin.db_path

const { keyword, pin, number: adminNumber } = settings.admin

// ── Auth ──────────────────────────────────────────────────────────────────────

function isAdmin(phone) {
    return String(phone).replace(/@.*$/, "").replace(/\D/g, "").endsWith(adminNumber.replace(/\D/g, ""))
}

// Returns { isAdmin: true, mode, payload } or { isAdmin: false }
function parseAdminMessage(message) {
    if (!message) return { isAdmin: false }
    const trimmed = message.trim()

    // <keyword> <pin> <command or query>
    const parts = trimmed.split(/\s+/)
    if (parts[0].toLowerCase() === keyword.toLowerCase() && parts[1] === pin) {
        return { isAdmin: true, payload: parts.slice(2).join(" ") }
    }

    return { isAdmin: false }
}

// ── Shell execution ───────────────────────────────────────────────────────────

const SHELL_PATTERNS = [
    /^pm2\s/i,
    /^tail\s/i,
    /^cat\s/i,
    /^ls\s*/i,
    /^df\s*/i,
    /^du\s/i,
    /^uptime/i,
    /^node\s/i,
    /^npm\s/i,
    /^kill\s/i,
    /^ping\s/i,
]

function looksLikeShell(text) {
    return SHELL_PATTERNS.some(p => p.test(text.trim()))
}

function runShell(cmd) {
    return new Promise(resolve => {
        exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
            const out = (stdout || stderr || "").trim()
            resolve(err && !out ? `❌ ${err.message}` : out || "✅ Done (no output)")
        })
    })
}

// ── DB context builder ────────────────────────────────────────────────────────

function buildDbContext(workspaceId) {
    const dbPath = loadProfile(workspaceId).dbPath || DB_PATH
    const db = new Database(dbPath, { readonly: true })
    try {
        const now = new Date()
        const thisMonth = now.toISOString().slice(0, 7)   // YYYY-MM
        const thisYear  = now.toISOString().slice(0, 4)   // YYYY
        const today     = now.toISOString().slice(0, 10)  // YYYY-MM-DD

        const todayOrders = db.prepare(`
            SELECT id, customer_name, phone, total, delivery_status, payment_status, order_for, expected_delivery
            FROM orders WHERE order_for = ?
            ORDER BY created_at DESC
        `).all(today)

        const todayRevenue = todayOrders.filter(o => o.payment_status === "Paid").reduce((s, o) => s + o.total, 0)

        const monthRevenue = db.prepare(`
            SELECT COALESCE(SUM(total),0) as rev, COUNT(*) as cnt
            FROM orders WHERE payment_status='Paid' AND order_date LIKE ?
        `).get(`${thisMonth}%`)

        const monthExpenses = db.prepare(`
            SELECT COALESCE(SUM(expense),0) as exp, COALESCE(SUM(income),0) as inc
            FROM expenses WHERE entry_date LIKE ? OR entry_date LIKE ?
        `).get(`${thisMonth}%`, `%/${now.getMonth()+1 < 10 ? '0'+(now.getMonth()+1) : now.getMonth()+1}/${thisYear}`)

        const yearRevenue = db.prepare(`
            SELECT COALESCE(SUM(total),0) as rev, COUNT(*) as cnt
            FROM orders WHERE payment_status='Paid' AND order_date LIKE ?
        `).get(`${thisYear}%`)

        const yearExpenses = db.prepare(`
            SELECT COALESCE(SUM(expense),0) as exp, COALESCE(SUM(income),0) as inc
            FROM expenses WHERE entry_date LIKE ? OR entry_date LIKE ?
        `).get(`${thisYear}%`, `%/${thisYear}`)

        const activeOrders = db.prepare(`
            SELECT id, customer_name, phone, total, delivery_status, payment_status, order_for, expected_delivery
            FROM orders WHERE delivery_status NOT IN ('Delivered','Cancelled')
            ORDER BY created_at DESC LIMIT 20
        `).all()

        const recentOrders = db.prepare(`
            SELECT id, customer_name, phone, total, delivery_status, payment_status, order_for
            FROM orders ORDER BY created_at DESC LIMIT 10
        `).all()

        const unpaidOrders = db.prepare(`
            SELECT id, customer_name, phone, total, order_for
            FROM orders WHERE payment_status != 'Paid' AND delivery_status NOT IN ('Delivered','Cancelled')
            ORDER BY created_at DESC
        `).all()

        return `
=== BUSINESS SUMMARY ===
Date: ${now.toDateString()} (${today})

Today (${today}):
- Orders: ${todayOrders.length}
- Paid revenue: ₹${todayRevenue}
- Orders detail:
${todayOrders.map(o => `  • ${o.id} | ${o.customer_name} | ₹${o.total} | Delivery: ${o.delivery_status} | Payment: ${o.payment_status}`).join("\n") || "  None"}

This Month (${thisMonth}):
- Revenue from orders: ₹${monthRevenue.rev} (${monthRevenue.cnt} paid orders)
- Expenses: ₹${monthExpenses.exp}
- Other income: ₹${monthExpenses.inc}
- Net profit: ₹${monthRevenue.rev + monthExpenses.inc - monthExpenses.exp}

This Year (${thisYear}):
- Revenue from orders: ₹${yearRevenue.rev} (${yearRevenue.cnt} paid orders)
- Expenses: ₹${yearExpenses.exp}
- Other income: ₹${yearExpenses.inc}
- Net profit: ₹${yearRevenue.rev + yearExpenses.inc - yearExpenses.exp}

Active Orders (${activeOrders.length}):
${activeOrders.map(o => `- ${o.id} | ${o.customer_name} | ${o.phone} | ₹${o.total} | Delivery: ${o.delivery_status} | Payment: ${o.payment_status} | For: ${o.order_for} by ${o.expected_delivery}`).join("\n") || "None"}

Unpaid Active Orders (${unpaidOrders.length}):
${unpaidOrders.map(o => `- ${o.id} | ${o.customer_name} | ${o.phone} | ₹${o.total} | For: ${o.order_for}`).join("\n") || "None"}

Recent Orders (last 10):
${recentOrders.map(o => `- ${o.id} | ${o.customer_name} | ₹${o.total} | ${o.delivery_status} | ${o.payment_status}`).join("\n")}
`.trim()
    } finally {
        db.close()
    }
}

// ── LLM-driven dynamic SQL query ──────────────────────────────────────────────

function getDbSchema(dbPath) {
    const db = new Database(dbPath, { readonly: true })
    try {
        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).all().map(t => t.name)
        return tables.map(t => {
            const cols = db.prepare(`PRAGMA table_info("${t}")`).all()
            const sample = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid DESC LIMIT 2`).all()
            return `TABLE ${t} (${cols.map(c => `${c.name} ${c.type}`).join(", ")})\nSample rows: ${JSON.stringify(sample)}`
        }).join("\n\n")
    } finally { db.close() }
}

async function queryWithLlm(question, dbContext, workspaceId) {
    const businessName = settings.admin.business_name || "the business"
    const dbPath = loadProfile(workspaceId).dbPath || DB_PATH
    const schema = getDbSchema(dbPath)
    const now = new Date()
    const dd = String(now.getDate()).padStart(2, "0")
    const mm = String(now.getMonth() + 1).padStart(2, "0")
    const yyyy = now.getFullYear()

    // Step 1: generate SQL
    const sqlPrompt = `You are a SQLite expert for ${businessName}.
Today is ${yyyy}-${mm}-${dd} (also ${dd}/${mm}/${yyyy} in DD/MM/YYYY format).

Database schema:
${schema}

IMPORTANT:
- expenses.entry_date uses DD/MM/YYYY format (e.g. "${dd}/${mm}/${yyyy}")
- orders.order_date and orders.order_for use YYYY-MM-DD format
- Write a single read-only SELECT query to answer the question
- Return ONLY the raw SQL, no explanation, no markdown fences

Question: ${question}`

    let sql
    try {
        sql = (await complete(sqlPrompt) || "").trim().replace(/^```\w*\n?|\n?```$/g, "").trim()
    } catch {
        return "LLM unavailable for SQL generation. Raw data:\n" + dbContext
    }

    if (!sql || !/^SELECT\b/i.test(sql)) {
        // Fallback to summary-based answer
        return await summaryFallback(question, dbContext)
    }

    logger.info({ sql }, "admin query: generated SQL")

    // Step 2: execute SQL
    let rows
    const db = new Database(dbPath, { readonly: true })
    try {
        rows = db.prepare(sql).all()
    } catch (err) {
        logger.warn({ err, sql }, "admin query: SQL execution failed, falling back")
        return await summaryFallback(question, dbContext)
    } finally { db.close() }

    // Step 3: summarise results
    const answerPrompt = `You are an admin assistant for ${businessName}. Be concise, use ₹ for currency.

The admin asked: ${question}
SQL used: ${sql}
Results (${rows.length} rows): ${JSON.stringify(rows).slice(0, 4000)}

Provide a clear, concise answer.`

    try {
        return await complete(answerPrompt) || `Query returned ${rows.length} rows:\n${JSON.stringify(rows, null, 2)}`
    } catch {
        return `Query returned ${rows.length} rows:\n${JSON.stringify(rows, null, 2)}`
    }
}

async function summaryFallback(question, dbContext) {
    const businessName = settings.admin.business_name || "the business"
    const prompt = `You are an admin assistant for ${businessName}.
Answer the admin's question using ONLY the data provided below. Be concise and use numbers/facts directly.
Do not make up data. If something is not in the data, say so.

${dbContext}

Admin question: ${question}
Answer:`
    try {
        return await complete(prompt) || "No response from LLM."
    } catch {
        return "LLM unavailable. Raw data:\n" + dbContext
    }
}

// ── Main handler ──────────────────────────────────────────────────────────────

async function handleAdmin(payload, options = {}) {
    if (!payload) return "⚙️ Admin ready. Usage: `ray <pin> <command or question>`\n`ray <pin> agent <task>` for full agentic mode"
    const workspaceId = options.workspaceId || getActiveWorkspace()
    const role = options.role || settings.admin?.role || "super_admin"

    logger.info({ payload }, "admin: handling request")

    if (/^approvals\b/i.test(payload)) {
        const approvals = listApprovals("pending", workspaceId)
        if (!approvals.length) return "No pending approvals."
        return approvals.slice(0, 10).map(a =>
            `• ${a.id} | workspace: ${a.workspaceId} | tool: ${a.tool} | worker: ${a.worker} | created: ${a.createdAt}\n  task: ${a.task}`
        ).join("\n\n")
    }

    if (/^approve\s+/i.test(payload)) {
        const id = payload.replace(/^approve\s+/i, "").trim()
        const approval = approveRequest(id, workspaceId)
        if (!approval) return `Approval ${id} not found.`
        return `✅ Approved ${approval.id} for ${approval.tool}.\nRerun the task and include token ${approval.id} in the request.`
    }

    // Agentic mode — full OpenAI function-calling loop
    if (/^agent\s+/i.test(payload)) {
        const task = payload.replace(/^agent\s+/i, "").trim()
        logger.info({ task }, "admin: agentic mode")
        return await runAgentLoop(task, { workspaceId })
    }

    if (looksLikeShell(payload)) {
        const result = await runShell(payload)
        return `\`\`\`\n${result}\n\`\`\``
    }

    // Natural language — governance check then dynamic SQL via LLM
    const auth = authorizeToolCall({ role, worker: "operator", tool: "query_db", task: payload, workspaceId })
    if (!auth.allowed) return `⛔ ${auth.reason}${auth.approvalHint ? "\n" + auth.approvalHint : ""}`

    const dbContext = buildDbContext(workspaceId)
    return await queryWithLlm(payload, dbContext, workspaceId)
}

async function handleAdminImage(imageBase64, caption, options = {}) {
    const workspaceId = options.workspaceId || getActiveWorkspace()
    const cfg    = settings.admin.agent_llm || {}
    const apiKey = cfg.api_key
    const model  = cfg.model || "gpt-4o-mini"
    const apiUrl = cfg.url || "https://api.openai.com/v1/chat/completions"
    const dbPath = loadProfile(workspaceId).dbPath || DB_PATH

    // Step 1: vision LLM extracts entries as JSON
    const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
            model,
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: "Extract all expense and income entries from this image. Return ONLY a JSON array, no explanation. Each item: {\"heading\": string, \"expense\": number, \"income\": number, \"date\": \"DD/MM/YYYY or empty\", \"notes\": string}. Use 0 for the field that does not apply. Do not invent data not visible in the image." },
                    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } }
                ]
            }],
            max_tokens: 1000,
        })
    })
    const data = await res.json()
    if (!res.ok) return `❌ Vision error: ${data.error?.message || res.status}`

    const raw = data.choices?.[0]?.message?.content || ""
    const match = raw.match(/\[[\s\S]*\]/)
    if (!match) return `❌ Could not parse entries from image. LLM said: ${raw.slice(0, 200)}`

    let entries
    try { entries = JSON.parse(match[0]) } catch { return `❌ JSON parse failed: ${match[0].slice(0, 200)}` }
    if (!entries.length) return "No expense entries found in image."

    // Step 2: insert directly into DB
    const today = (() => { const d = new Date(); return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` })()
    const db   = new Database(dbPath)
    const stmt = db.prepare("INSERT INTO expenses (entry_date, expense, income, heading, notes) VALUES (?, ?, ?, ?, ?)")
    const inserted = []
    try {
        for (const e of entries) {
            stmt.run(e.date || today, Number(e.expense) || 0, Number(e.income) || 0, e.heading || "Expense", e.notes || "")
            inserted.push(`• ${e.heading} — ₹${e.expense || e.income} (${e.date || today})`)
        }
    } finally { db.close() }

    return `✅ Added ${inserted.length} entr${inserted.length === 1 ? "y" : "ies"}:\n${inserted.join("\n")}`
}

module.exports = { isAdmin, parseAdminMessage, handleAdmin, handleAdminImage }
