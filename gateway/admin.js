"use strict"

const { exec } = require("child_process")
const Database = require("better-sqlite3")
const { complete } = require("../providers/llm")
const { dispatchAgentTask } = require("./adminAgent")
const { approveRequest, listApprovals } = require("./adminApprovals")
const { authorizeToolCall } = require("./adminGovernance")
const { getActiveWorkspace } = require("../core/workspace")
const { loadProfile } = require("../setup/profileService")
const { loadNotes } = require("../core/dataModelNotes")
const { registerGuide } = require("../core/promptGuides")
const { getPackForWorkspace } = require("../core/domainPacks")
const logger = require("./logger")

function getSettings() { return require("../config/settings.json") }
function getAdminCfg() { return getSettings().admin }

// ── Auth ──────────────────────────────────────────────────────────────────────

function getUsers() {
    const cfg = getAdminCfg()
    if (cfg.users?.length) return cfg.users
    // backward compat: single admin.number + admin.pin
    if (cfg.number) return [{ phone: String(cfg.number), name: "Admin", role: cfg.role || "super_admin", mode: "full", pin: cfg.pin || "" }]
    return []
}

function normalizePhone(p) { return String(p || "").replace(/@.*$/, "").replace(/\D/g, "") }

// Returns matched user object or null
function isAdmin(phone) {
    const digits = normalizePhone(phone)
    return getUsers().find(u => digits.endsWith(normalizePhone(u.phone))) || null
}

// Returns { isAdmin: true, user, flow, payload } or { isAdmin: false }
function parseAdminMessage(message, phone) {
    if (!message) return { isAdmin: false }
    const user = isAdmin(phone)
    if (!user) return { isAdmin: false }

    const parts = message.trim().split(/\s+/)
    const adminKeyword = getAdminCfg().keyword || "ray"
    const agentKeyword = getAdminCfg().agent_keyword || "agent"
    
    let flow = null
    let payloadIdx = 1

    if (parts[0].toLowerCase() === adminKeyword.toLowerCase()) {
        flow = "admin"
    } else if (parts[0].toLowerCase() === agentKeyword.toLowerCase()) {
        flow = "agent"
    }

    if (!flow) return { isAdmin: false }

    const userPin = user.pin !== undefined ? user.pin : (getAdminCfg().pin || "")
    if (userPin === "") {
        // no pin required — everything after keyword is payload
        return { isAdmin: true, user, flow, payload: parts.slice(payloadIdx).join(" ") }
    }
    if (parts[1] !== userPin) return { isAdmin: false }
    return { isAdmin: true, user, flow, payload: parts.slice(payloadIdx + 1).join(" ") }
}

// ── Shell execution ───────────────────────────────────────────────────────────

const DEFAULT_SHELL_PATTERNS = ["pm2", "tail", "cat", "ls", "df", "du", "uptime", "node", "npm", "kill", "ping"]

function getShellPatterns() {
    return getAdminCfg().shell_patterns || DEFAULT_SHELL_PATTERNS
}

function looksLikeShell(text) {
    const cmd = text.trim().split(/\s/)[0].toLowerCase()
    return getShellPatterns().some(p => p.toLowerCase() === cmd)
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

function genericDbContext(dbPath, relevantTables = null) {
    const db = new Database(dbPath, { readonly: true })
    try {
        const allTables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).all().map(t => t.name)
        
        const tables = Array.isArray(relevantTables) 
            ? allTables.filter(t => relevantTables.includes(t))
            : allTables

        const lines = [`=== DATABASE SUMMARY ===`, `Date: ${new Date().toDateString()}`, `Tables: ${tables.join(", ")}`, ""]
        for (const t of tables) {
            const count = db.prepare(`SELECT COUNT(*) as c FROM "${t}"`).get().c
            const sample = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid DESC LIMIT 3`).all()
            lines.push(`TABLE ${t} (${count} rows):`)
            if (sample.length) lines.push(JSON.stringify(sample, null, 2))
            lines.push("")
        }
        return lines.join("\n")
    } finally { db.close() }
}

async function buildDbContext(workspaceId, relevantTables = null) {
    const profile = loadProfile(workspaceId)
    const dbPath = profile.dbPath || getAdminCfg().db_path

    // try domain pack's context builder first
    try {
        const pack = getPackForWorkspace(profile)
        if (pack?.buildAdminContext) {
            // Note: pack.buildAdminContext might be async now
            return await pack.buildAdminContext(dbPath, relevantTables)
        }
    } catch (err) {
        logger.warn({ err: err.message }, "admin: domain pack buildAdminContext failed, using generic")
    }

    // generic fallback — schema introspection
    return genericDbContext(dbPath, relevantTables)
}

// ── LLM-driven dynamic SQL query ──────────────────────────────────────────────

function getDbSchema(dbPath, relevantTables = null) {
    const db = new Database(dbPath, { readonly: true })
    try {
        const allTables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).all().map(t => t.name)

        const tables = Array.isArray(relevantTables)
            ? allTables.filter(t => relevantTables.includes(t))
            : allTables

        return tables.map(t => {
            const cols = db.prepare(`PRAGMA table_info("${t}")`).all()
            return `TABLE ${t} (${cols.map(c => c.name).join(", ")})`
        }).join("\n")
    } finally { db.close() }
}

async function queryWithLlm(question, dbContext, workspaceId) {
    const businessName = getAdminCfg().business_name || "the business"
    const dbPath = loadProfile(workspaceId).dbPath || getAdminCfg().db_path
    const schema = getDbSchema(dbPath)
    const now = new Date()
    const dd = String(now.getDate()).padStart(2, "0")
    const mm = String(now.getMonth() + 1).padStart(2, "0")
    const yyyy = now.getFullYear()

    const adminLlmCfg = getAdminCfg().agent_llm || {}

    // Step 1: generate SQL
    const notes = loadNotes(workspaceId)
    const sqlPrompt = `You are a SQLite expert for ${businessName}.
Today is ${yyyy}-${mm}-${dd} (also ${dd}/${mm}/${yyyy} in DD/MM/YYYY format).

Database schema:
${schema}
${notes ? `\nData model notes:\n${notes}\n` : ""}
IMPORTANT:
- Write a single read-only SELECT query to answer the question
- Return ONLY the raw SQL, no explanation, no markdown fences

Question: ${question}`

    let sql
    try {
        sql = (await complete(sqlPrompt, adminLlmCfg) || "").trim().replace(/^```\w*\n?|\n?```$/g, "").trim()
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
    const profile = loadProfile(workspaceId)
    const currency = profile.currency || ""
    const currencyHint = currency ? ` Use ${currency} for currency.` : ""
    const answerPrompt = `You are an admin assistant for ${businessName}. Be concise.${currencyHint}

The admin asked: ${question}
SQL used: ${sql}
Results (${rows.length} rows): ${JSON.stringify(rows).slice(0, 4000)}

Provide a clear, concise answer.`

    try {
        return await complete(answerPrompt, adminLlmCfg) || `Query returned ${rows.length} rows:\n${JSON.stringify(rows, null, 2)}`
    } catch {
        return `Query returned ${rows.length} rows:\n${JSON.stringify(rows, null, 2)}`
    }
}

async function summaryFallback(question, dbContext) {
    const businessName = getAdminCfg().business_name || "the business"
    const adminLlmCfg = getAdminCfg().agent_llm || {}
    const prompt = `You are an admin assistant for ${businessName}.
Answer the admin's question using ONLY the data provided below. Be concise and use numbers/facts directly.
Do not make up data. If something is not in the data, say so.

${dbContext}

Admin question: ${question}
Answer:`
    try {
        return await complete(prompt, adminLlmCfg) || "No response from LLM."
    } catch {
        return "LLM unavailable. Raw data:\n" + dbContext
    }
}

// ── Main handler ──────────────────────────────────────────────────────────────

async function selectRelevantTables(task, workspaceId) {
    const profile = loadProfile(workspaceId)
    const dbPath = profile.dbPath || getAdminCfg().db_path
    const allTables = new Database(dbPath, { readonly: true })
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all().map(t => t.name)
    
    if (allTables.length <= 3) return allTables // too few tables, just send all

    const notes = loadNotes(workspaceId)
    const prompt = `You are a database expert. Given a task and a list of tables, select ONLY the tables that are relevant to the task. 
The task is: "${task}"

Available tables:
${allTables.join(", ")}

${notes ? `\nData model notes:\n${notes}\n` : ""}

Return ONLY a comma-separated list of table names, no other text.`

    try {
        const adminLlmCfg = getAdminCfg().agent_llm || {}
        const res = await complete(prompt, { ...adminLlmCfg, max_tokens: 50 })
        if (!res) return allTables
        const selected = res.split(",").map(s => s.trim()).filter(s => allTables.includes(s))
        return selected.length > 0 ? selected : allTables
    } catch {
        return allTables
    }
}

async function handleAdmin(payload, options = {}) {
    const flow = options.flow || "admin" // default to admin flow
    if (!payload) return `⚙️ ${flow === "agent" ? "Agent" : "Admin"} ready. Usage: \`${flow === "agent" ? (getAdminCfg().agent_keyword || "agent") : (getAdminCfg().keyword || "ray")} <pin> <command or question>\``
    
    const workspaceId = options.workspaceId || getActiveWorkspace()
    const user = options.user || {}
    const role = user.role || options.role || getAdminCfg()?.role || "super_admin"
    const mode = user.mode || "full"

    logger.info({ payload, user: user.name, role, mode, flow }, "admin: handling request")

    const allowedTools = flow === "agent" 
        ? (getAdminCfg().agent_tools || ["run_shell", "mac_automation", "query_db", "send_whatsapp", "http_request", "open_browser", "screenshot", "click", "fill", "skill_call"])
        : (getAdminCfg().tools || ["query_db", "shell"])

    if (flow === "admin" && !allowedTools.includes("approvals") && /^approvals\b/i.test(payload)) {
        // approvals not explicitly in default tools, but let's keep it functional unless blocked
    }

    if (/^approvals\b/i.test(payload)) {
        if (flow === "admin" && !allowedTools.includes("query_db")) return "⛔ Your tool allowlist does not include query/approval access."
        const approvals = listApprovals("pending", workspaceId)
        if (!approvals.length) return "No pending approvals."
        return approvals.slice(0, 10).map(a =>
            `• ${a.id} | workspace: ${a.workspaceId} | tool: ${a.tool} | worker: ${a.worker} | created: ${a.createdAt}\n  task: ${a.task}`
        ).join("\n\n")
    }

    if (/^approve\s+/i.test(payload)) {
        if (mode === "query_only") return "⛔ Your access level does not allow approvals."
        if (flow === "admin" && !allowedTools.includes("query_db")) return "⛔ Your tool allowlist does not include approval access."
        const id = payload.replace(/^approve\s+/i, "").trim()
        const approval = approveRequest(id, workspaceId)
        if (!approval) return `Approval ${id} not found.`
        return `✅ Approved ${approval.id} for ${approval.tool}.\nRerun the task and include token ${approval.id} in the request.`
    }

    // Agentic mode — full OpenAI function-calling loop
    if (flow === "agent" || /^agent\s+/i.test(payload) || (flow === "admin" && getAdminCfg()?.default_to_agent)) {
        if (mode === "query_only" || mode === "shell_only") {
             if (flow === "agent" || !getAdminCfg()?.default_to_agent || /^agent\s+/i.test(payload)) {
                 return `⛔ Your access level (${mode}) does not allow agentic mode.`
             }
             // if default_to_agent is on but mode is restricted, we fall through to existing logic
        } else {
            const isExplicitAgent = flow === "agent" || /^agent\s+/i.test(payload)
            const task = payload.replace(/^agent\s+/i, "").trim()
            logger.info({ task, user: user.name, isExplicitAgent }, "admin: agentic mode")
            // Only set noContext: true if it's an explicit "agent" command
            return await dispatchAgentTask(task, { workspaceId, role, noContext: isExplicitAgent })
        }
    }

    // Auto-route mutations to agentic mode
    if (/\b(add|record|insert|update|change|set|delete|remove|mark)\b/i.test(payload)) {
        if (mode === "query_only" || mode === "shell_only") return `⛔ Your access level (${mode}) does not allow mutations.`
        logger.info({ payload, user: user.name }, "admin: mutation detected, routing to agent")
        return await dispatchAgentTask(payload, { workspaceId, role })
    }

    if (looksLikeShell(payload)) {
        if (mode === "query_only" || mode === "agent_only") return `⛔ Your access level (${mode}) does not allow shell commands.`
        if (flow === "admin" && !allowedTools.includes("shell")) return "⛔ Your tool allowlist does not include shell commands."
        const result = await runShell(payload)
        return `\`\`\`\n${result}\n\`\`\``
    }

    // Natural language — governance check then dynamic SQL via LLM
    if (flow === "admin" && !allowedTools.includes("query_db")) return "⛔ Your tool allowlist does not include database queries."
    const auth = authorizeToolCall({ role, worker: "operator", tool: "query_db", task: payload, workspaceId })
    if (!auth.allowed) return `⛔ ${auth.reason}${auth.approvalHint ? "\n" + auth.approvalHint : ""}`

    const dbContext = buildDbContext(workspaceId)
    return await queryWithLlm(payload, dbContext, workspaceId)
}

async function handleAdminImage(imageBase64, caption, options = {}) {
    const workspaceId = options.workspaceId || getActiveWorkspace()
    const cfg    = getAdminCfg().agent_llm || {}
    const apiKey = cfg.api_key
    const model  = cfg.model || "gpt-4o-mini"
    const apiUrl = cfg.url || "https://api.openai.com/v1/chat/completions"
    const profile = loadProfile(workspaceId)
    const dbPath = profile.dbPath || getAdminCfg().db_path

    // resolve domain pack for vision prompt and insertion
    let pack = null
    try { pack = getPackForWorkspace(profile) } catch {}
    const visionText = pack?.visionPrompt || 'Extract all structured entries from this image. Return ONLY a JSON array, no explanation. Each item should have relevant fields as key-value pairs.'

    // Step 1: vision LLM extracts entries as JSON
    const res = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
            model,
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: visionText },
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
    if (!entries.length) return "No entries found in image."

    // Step 2: delegate insertion to domain pack if available
    if (pack?.insertVisionEntries) {
        try {
            const inserted = pack.insertVisionEntries(entries, dbPath)
            return `✅ Added ${inserted.length} entr${inserted.length === 1 ? "y" : "ies"}:\n${inserted.join("\n")}`
        } catch (err) {
            return `❌ Insert failed: ${err.message}`
        }
    }

    // generic fallback — return parsed entries as text
    return `📋 Parsed ${entries.length} entries from image:\n${JSON.stringify(entries, null, 2).slice(0, 2000)}`
}

registerGuide({
    id: "admin-query-sql",
    name: "Admin query — SQL generation",
    description: "Prompt sent to the LLM to generate a read-only SQL query from a natural language question. Used in query mode (non-agent).",
    source: "gateway/admin.js",
    editable: "Data model notes section — via POST /setup/agent/notes",
    render(workspaceId) {
        const biz = (loadProfile(workspaceId).businessName || workspaceId)
        const notes = loadNotes(workspaceId)
        const notesBlock = notes ? `\nData model notes:\n${notes}\n` : ""
        return `You are a SQLite expert for ${biz}.\nToday is YYYY-MM-DD.\n\nDatabase schema: (introspected at runtime)\n${notesBlock}\nReturn ONLY raw SQL, no explanation.\n\nQuestion: (user's question at runtime)`
    },
})

module.exports = { 
    isAdmin, 
    parseAdminMessage, 
    handleAdmin, 
    handleAdminImage, 
    getShellPatterns, 
    getUsers, 
    buildDbContext, 
    getDbSchema,
    selectRelevantTables
}
