"use strict"

const { exec } = require("child_process")
const Database = require("better-sqlite3")
const fetch = require("node-fetch")
const settings = require("../config/settings.json")
const logger = require("./logger")

const DB_PATH = "/Users/deepjyotiray/Documents/FoodWebsite/ray-orders-backend/orders.db"

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

function buildDbContext() {
    const db = new Database(DB_PATH, { readonly: true })
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
            FROM expenses WHERE entry_date LIKE ?
        `).get(`${thisMonth}%`)

        const yearRevenue = db.prepare(`
            SELECT COALESCE(SUM(total),0) as rev, COUNT(*) as cnt
            FROM orders WHERE payment_status='Paid' AND order_date LIKE ?
        `).get(`${thisYear}%`)

        const yearExpenses = db.prepare(`
            SELECT COALESCE(SUM(expense),0) as exp, COALESCE(SUM(income),0) as inc
            FROM expenses WHERE entry_date LIKE ?
        `).get(`${thisYear}%`)

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

// ── LLM natural language query ────────────────────────────────────────────────

async function queryWithLlm(question, dbContext) {
    const prompt = `You are an admin assistant for Ray's Home Kitchen food business.
Answer the admin's question using ONLY the data provided below. Be concise and use numbers/facts directly.
Do not make up data. If something is not in the data, say so.

${dbContext}

Admin question: ${question}
Answer:`

    try {
        const res = await fetch(settings.ollama.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: settings.ollama.model, prompt, stream: false })
        })
        const data = await res.json()
        return (data.response || "").trim() || "No response from LLM."
    } catch {
        return "LLM unavailable. Raw data:\n" + dbContext
    }
}

// ── Main handler ──────────────────────────────────────────────────────────────

async function handleAdmin(payload) {
    if (!payload) return "⚙️ Admin ready. Usage: `ray <pin> <command or question>`"

    logger.info({ payload }, "admin: handling request")

    if (looksLikeShell(payload)) {
        const result = await runShell(payload)
        return `\`\`\`\n${result}\n\`\`\``
    }

    // Natural language — build DB context and ask LLM
    const dbContext = buildDbContext()
    return await queryWithLlm(payload, dbContext)
}

module.exports = { isAdmin, parseAdminMessage, handleAdmin }
