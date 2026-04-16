"use strict"

const Database = require("better-sqlite3")

// ── Tool definitions (OpenAI function-calling format) ─────────────────────────

const toolDefinitions = [
    {
        type: "function",
        function: {
            name: "add_expense",
            description: "Add a manual expense or income entry to the expenses table. Use for recording daily expenses, purchases, or income.",
            parameters: {
                type: "object",
                properties: {
                    heading:    { type: "string", description: "Short label e.g. 'Vegetables', 'Gas', 'Salary'" },
                    expense:    { type: "number", description: "Expense amount in rupees (0 if income entry)" },
                    income:     { type: "number", description: "Income amount in rupees (0 if expense entry)" },
                    notes:      { type: "string", description: "Optional extra details" },
                    entry_date: { type: "string", description: "Date in DD/MM/YYYY format e.g. 27/02/2026. Defaults to today if omitted." }
                },
                required: ["heading"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "update_order",
            description: "Update delivery_status or payment_status of an order by order ID.",
            parameters: {
                type: "object",
                properties: {
                    order_id:        { type: "string", description: "The order ID" },
                    delivery_status: { type: "string", description: "New delivery status e.g. Confirmed, Preparing, Out for Delivery, Delivered, Cancelled" },
                    payment_status:  { type: "string", description: "New payment status e.g. Paid, Pending, Failed" }
                },
                required: ["order_id"]
            }
        }
    },
]

// ── Tool implementations ──────────────────────────────────────────────────────

function hasColumn(db, tableName, columnName) {
    return db.prepare(`PRAGMA table_info("${tableName}")`).all().some(col => col.name === columnName)
}

function ensureExpensesSchema(db) {
    const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get("expenses")
    if (!tableExists) {
        db.exec(`
            CREATE TABLE expenses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                entry_date TEXT NOT NULL,
                expense INTEGER DEFAULT 0,
                income INTEGER DEFAULT 0,
                heading TEXT,
                notes TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )
        `)
    }

    if (!hasColumn(db, "expenses", "created_at")) {
        db.exec("ALTER TABLE expenses ADD COLUMN created_at DATETIME")
    }

    db.exec(`
        UPDATE expenses
        SET created_at = CASE
            WHEN entry_date LIKE '__/__/____'
                THEN substr(entry_date, 7, 4) || '-' || substr(entry_date, 4, 2) || '-' || substr(entry_date, 1, 2) || ' 00:00:00'
            ELSE CURRENT_TIMESTAMP
        END
        WHERE created_at IS NULL OR TRIM(CAST(created_at AS TEXT)) = ''
    `)

    db.exec("CREATE INDEX IF NOT EXISTS idx_expenses_entry_date ON expenses(entry_date)")
    db.exec("CREATE INDEX IF NOT EXISTS idx_expenses_created_at ON expenses(created_at)")
}

function addExpense({ heading, expense = 0, income = 0, notes = "", entry_date }, dbPath) {
    const db = new Database(dbPath)
    try {
        ensureExpensesSchema(db)
        const date = entry_date || (() => {
            const d = new Date()
            return `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`
        })()
        const result = db.prepare(
            "INSERT INTO expenses (entry_date, expense, income, heading, notes, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))"
        ).run(date, expense, income, heading, notes)
        return `✅ Expense added (id:${result.lastInsertRowid}): ${heading} | expense:₹${expense} income:₹${income} | date:${date}`
    } catch (err) {
        return `❌ DB error: ${err.message}`
    } finally { db.close() }
}

function updateOrder(args, dbPath) {
    const { order_id, delivery_status, payment_status } = args
    const db = new Database(dbPath)
    try {
        const sets = [], vals = []
        if (delivery_status) { sets.push("delivery_status = ?"); vals.push(delivery_status) }
        if (payment_status)  { sets.push("payment_status = ?");  vals.push(payment_status) }
        if (!sets.length) return "❌ Provide delivery_status or payment_status."
        vals.push(order_id)
        const result = db.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
        return result.changes > 0
            ? `✅ Order ${order_id} updated.${delivery_status ? ` Delivery: ${delivery_status}.` : ""}${payment_status ? ` Payment: ${payment_status}.` : ""}`
            : `❌ Order ${order_id} not found.`
    } catch (err) {
        return `❌ DB error: ${err.message}`
    } finally { db.close() }
}

// ── Dispatch (called by adminAgent when tool name matches) ────────────────────

function dispatch(toolName, args, dbPath) {
    switch (toolName) {
        case "add_expense":  return addExpense(args, dbPath)
        case "update_order": return updateOrder(args, dbPath)
        default:             return null
    }
}

const { retrieveContext } = require("../../../rag")

// ── Admin context builder (uses RAG to provide business knowledge) ──────────────

async function buildAdminContext() {
    try {
        const now = new Date()
        const todayStr = now.toISOString().slice(0, 10)
        
        // Retrieve relevant admin and business context from vector DB
        const knowledge = await retrieveContext("admin business KPI definitions summary dashboard", { type: "admin" })
        
        return `
=== BUSINESS KNOWLEDGE ===
Current Date: ${now.toDateString()} (${todayStr})

${knowledge}

---
USE TOOLS TO GET LIVE DATA:
- query_db: use for SQL queries to get revenue, orders, and subscriptions.
- server_health: use to check system status.
- run_shell: use for process logs or server commands.
`.trim()
    } catch (err) {
        return `⚠️ Context retrieval failed: ${err.message}`
    }
}

// ── Vision prompt for expense image parsing ───────────────────────────────────

const visionPrompt = 'Extract all expense and income entries from this image. Return ONLY a JSON array, no explanation. Each item: {"heading": string, "expense": number, "income": number, "date": "DD/MM/YYYY or empty", "notes": string}. Use 0 for the field that does not apply. Do not invent data not visible in the image.'

function insertVisionEntries(entries, dbPath) {
    const today = (() => { const d = new Date(); return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}` })()
    const db = new Database(dbPath)
    ensureExpensesSchema(db)
    const stmt = db.prepare("INSERT INTO expenses (entry_date, expense, income, heading, notes, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))")
    const inserted = []
    try {
        for (const e of entries) {
            stmt.run(e.date || today, Number(e.expense) || 0, Number(e.income) || 0, e.heading || "Expense", e.notes || "")
            inserted.push(`• ${e.heading} — ₹${e.expense || e.income} (${e.date || today})`)
        }
    } finally { db.close() }
    return inserted
}

function listMonthlyExpenses(dbPath, month) {
    const db = new Database(dbPath)
    try {
        ensureExpensesSchema(db)
        const now = new Date()
        const resolvedMonth = /^\d{4}-\d{2}$/.test(String(month || ""))
            ? String(month)
            : `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
        const rows = db.prepare(`
            SELECT id, entry_date, expense, income, heading, notes, created_at
            FROM expenses
            WHERE substr(entry_date, 7, 4) || '-' || substr(entry_date, 4, 2) = ?
            ORDER BY substr(entry_date, 7, 4) || '-' || substr(entry_date, 4, 2) || '-' || substr(entry_date, 1, 2) DESC,
                     created_at DESC,
                     id DESC
        `).all(resolvedMonth)
        const totals = rows.reduce((acc, row) => {
            acc.expense += Number(row.expense) || 0
            acc.income += Number(row.income) || 0
            return acc
        }, { expense: 0, income: 0 })
        return { month: resolvedMonth, rows, totals }
    } finally {
        db.close()
    }
}

module.exports = { toolDefinitions, dispatch, buildAdminContext, visionPrompt, insertVisionEntries, ensureExpensesSchema, listMonthlyExpenses }
