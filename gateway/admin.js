"use strict"

const { exec } = require("child_process")
const Database = require("better-sqlite3")
const { complete, getFlowConfig } = require("../providers/llm")
const { prepareRequest } = require("../runtime/contextPipeline")
const { dispatchAgentTask } = require("./adminAgent")
const { approveRequest, listApprovals } = require("./adminApprovals")
const { authorizeToolCall } = require("./adminGovernance")
const { getActiveWorkspace } = require("../core/workspace")
const { loadProfile } = require("../setup/profileService")
const { loadNotes } = require("../core/dataModelNotes")
const { registerGuide } = require("../core/promptGuides")
const { getPackForWorkspace, extractPackConversationState } = require("../core/domainPacks")
const flowMemory = require("../runtime/flowMemory")
const conversationState = require("../runtime/conversationState")
const { resolveFollowUp } = require("../runtime/followUpResolver")
const { buildResolvedRequest } = require("../runtime/resolvedRequest")
const { decideAdminExecution } = require("../runtime/flowOrchestrator")
const logger = require("./logger")

function getSettings() { return require("../config/settings.json") }
function getAdminCfg() { return getSettings().admin }
function getFlowCfg(flow) { return getSettings().flows?.[flow] || {} }
const DEFAULT_ADMIN_TOOLS = ["query_db", "shell", "approvals"]
const DEFAULT_AGENT_TOOLS = ["run_shell", "mac_automation", "query_db", "send_whatsapp", "http_request", "open_browser", "screenshot", "click", "fill", "run_skill"]

// ── Auth ──────────────────────────────────────────────────────────────────────

function getUsers() {
    const cfg = getAdminCfg()
    if (cfg.users?.length) return cfg.users
    // backward compat: single admin.number + admin.pin
    if (cfg.number) return [{ phone: String(cfg.number), name: "Admin", role: cfg.role || "super_admin", mode: "full", pin: cfg.pin || "" }]
    return []
}

function normalizePhone(p) { return String(p || "").replace(/@.*$/, "").replace(/\D/g, "") }

function getFlowAccessConfig(flow) {
    const settings = getSettings()
    const flowCfg = settings.flows?.[flow] || {}
    const auth = flowCfg.auth || {}
    const defaultKeyword = flow === "agent"
        ? (settings.admin?.agent_keyword || "agent")
        : (settings.admin?.keyword || "admin")
    const allKnownNumbers = getUsers().map(u => String(u.phone || "")).filter(Boolean)
    const fallbackNumbers = settings.admin?.number ? [String(settings.admin.number)] : []
    const allowedNumbers = Array.isArray(auth.allowed_numbers) && auth.allowed_numbers.length
        ? auth.allowed_numbers.map(normalizePhone).filter(Boolean)
        : [...new Set([...allKnownNumbers, ...fallbackNumbers].map(normalizePhone).filter(Boolean))]
    const pin = auth.pin !== undefined
        ? String(auth.pin)
        : (flow === "admin" ? String(settings.admin?.pin || "") : String(settings.admin?.pin || ""))

    return {
        keyword: String(auth.keyword || defaultKeyword).trim(),
        pin,
        allowedNumbers,
    }
}

function getAllowedToolsForFlow(flow) {
    const cfg = getAdminCfg() || {}
    if (flow === "agent") {
        const tools = Array.isArray(cfg.agent_tools) ? cfg.agent_tools.filter(Boolean) : []
        return tools.length ? tools : DEFAULT_AGENT_TOOLS
    }

    const tools = Array.isArray(cfg.tools) ? cfg.tools.filter(Boolean) : []
    const hasAdminCapabilities = tools.includes("query_db") || tools.includes("shell") || tools.includes("approvals")
    return hasAdminCapabilities ? tools : DEFAULT_ADMIN_TOOLS
}

function getAdminQueryLlmConfig() {
    const settings = getSettings()
    const flowAdminLlm = settings.flows?.admin?.llm || {}
    const baseAdminLlm = settings.admin?.llm || {}
    const fallbackAgentLlm = settings.admin?.agent_llm || {}
    return {
        provider: flowAdminLlm.provider || baseAdminLlm.provider || fallbackAgentLlm.provider || "openai",
        model: flowAdminLlm.model || baseAdminLlm.model || fallbackAgentLlm.model || "gpt-4o-mini",
        api_key: flowAdminLlm.api_key || baseAdminLlm.api_key || fallbackAgentLlm.api_key || "",
        base_url: flowAdminLlm.base_url || baseAdminLlm.base_url || baseAdminLlm.url || fallbackAgentLlm.base_url || fallbackAgentLlm.url || "",
        backend: settings.flows?.admin?.backend || settings.admin?.backend || "direct",
    }
}

function getAdminDirectLlmConfig() {
    return {
        ...getAdminQueryLlmConfig(),
        backend: "direct",
    }
}

function buildAdminProfileFacts(profile = {}) {
    const lines = []
    for (const [k, v] of Object.entries(profile)) {
        if (!v || typeof v !== "string") continue
        if (["openaiKey", "workspaceId", "agentManifest", "domainPack", "scrapeWebsite"].includes(k)) continue
        lines.push(`- ${k}: ${v}`)
    }
    return lines.join("\n") || "No profile data available."
}

async function loadAdminRagHints(question, workspaceId) {
    try {
        const profile = loadProfile(workspaceId)
        const dbPath = profile.dbPath || getAdminCfg().db_path
        if (!dbPath) return ""
        const rag = require("../tools/genericRagTool")
        const result = await rag.execute({}, { rawMessage: question }, { db_path: dbPath })
        if (!result || /nothing matched/i.test(result)) return ""
        return result.split("\n").slice(0, 12).join("\n")
    } catch {
        return ""
    }
}

async function answerAdminViaConfiguredMode(resolvedRequest, workspaceId, conversationId = workspaceId) {
    const question = resolvedRequest.effectiveMessage || resolvedRequest.originalMessage || ""
    const profile = loadProfile(workspaceId)
    const businessName = profile.businessName || getAdminCfg().business_name || "the business"
    const dbPath = profile.dbPath || getAdminCfg().db_path
    const flowCfg = getAdminQueryLlmConfig()
    const relevantTables = await selectRelevantTables(question, workspaceId)
    const dbContext = await buildDbContext(workspaceId, relevantTables)
    const schema = getDbSchema(dbPath, relevantTables)
    const notes = loadNotes(workspaceId)
    const ragHints = await loadAdminRagHints(question, workspaceId)
    const profileFacts = buildAdminProfileFacts(profile)
    const systemContext = `You are an admin assistant for ${businessName}.
Answer using the provided business profile, database context, schema, notes, and retrieval hints.
If the configured mode is a backend service, keep this request on that backend path.
Be concise, accurate, and operationally useful.`
    const dynamicContext = [
        "=== DATABASE CONTEXT ===",
        dbContext,
        "",
        "=== DATABASE SCHEMA ===",
        schema,
        notes ? `\n=== DATA MODEL NOTES ===\n${notes}` : "",
        ragHints ? `\n=== RETRIEVAL HINTS ===\n${ragHints}` : "",
    ].filter(Boolean).join("\n")
    const prompt = `Admin request:\n${question}`
    const history = flowMemory.getHistory("admin", conversationId)
    const messages = prepareRequest(prompt, "admin", {
        systemContext,
        profileFacts,
        dynamicContext,
        history,
        conversationState: conversationState.getState("admin", conversationId),
        resolvedRequest,
    })
    return await complete(messages, { flow: "admin", llmConfig: flowCfg }) || "No response from configured admin service."
}

async function finalizeAdminResponse(payload, options, work) {
    const response = await work()
    const flow = options.flow || "admin"
    const conversationId = options.phone || options.workspaceId || getActiveWorkspace()
    if (flow === "admin" && payload && response) {
        const profile = loadProfile(options.workspaceId || getActiveWorkspace())
        const pack = getPackForWorkspace(profile)
        const packState = extractPackConversationState(pack, {
            flow: "admin",
            message: payload,
            response,
            conversationState: conversationState.getState("admin", conversationId),
        }) || {}
        flowMemory.addTurn("admin", conversationId, payload, response, options.user?.name || options.role || "admin")
        conversationState.recordInteraction("admin", conversationId, {
            message: payload,
            response,
            route: flow,
            task: "admin_request",
            ...packState,
        })
    }
    return response
}

function getUserForFlow(phone, flow) {
    const digits = normalizePhone(phone)
    const matched = getUsers().find(u => digits.endsWith(normalizePhone(u.phone)))
    if (matched) return matched

    const access = getFlowAccessConfig(flow)
    if (access.allowedNumbers.some(n => digits.endsWith(n))) {
        return {
            phone: digits,
            name: flow === "agent" ? "Agent User" : "Admin User",
            role: getAdminCfg()?.role || "super_admin",
            mode: "full",
            pin: access.pin || "",
        }
    }
    return null
}

// Returns matched user object or null
function isAdmin(phone) {
    const digits = normalizePhone(phone)
    return getUserForFlow(digits, "admin") || getUserForFlow(digits, "agent") || null
}

// Returns { isAdmin: true, user, flow, payload } or an auth failure / customer fallback descriptor
function parseAdminMessage(message, phone) {
    if (!message) return { isAdmin: false }
    const parts = message.trim().split(/\s+/)
    const first = String(parts[0] || "").toLowerCase()
    const adminAccess = getFlowAccessConfig("admin")
    const agentAccess = getFlowAccessConfig("agent")

    let flow = null
    let access = null
    if (first === adminAccess.keyword.toLowerCase()) {
        flow = "admin"
        access = adminAccess
    } else if (first === agentAccess.keyword.toLowerCase()) {
        flow = "agent"
        access = agentAccess
    }

    if (!flow) return { isAdmin: false }

    const user = getUserForFlow(phone, flow)
    if (!user) {
        return { isAdmin: false, matchedFlow: true, flow, error: "unauthorized_number", message: `⛔ This number is not allowed for ${flow} flow.` }
    }

    const expectedPin = String(access.pin || "")
    const suppliedPin = String(parts[1] || "")
    if (expectedPin && suppliedPin !== expectedPin) {
        return { isAdmin: false, matchedFlow: true, flow, error: "wrong_pin", message: `⛔ Wrong PIN for ${flow} flow.` }
    }

    const payloadIdx = expectedPin ? 2 : 1
    return { isAdmin: true, user, flow, payload: parts.slice(payloadIdx).join(" ") }
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

async function queryWithLlm(resolvedRequest, dbContext, workspaceId, conversationId = workspaceId) {
    const question = resolvedRequest.effectiveMessage || resolvedRequest.originalMessage || ""
    const businessName = getAdminCfg().business_name || "the business"
    const dbPath = loadProfile(workspaceId).dbPath || getAdminCfg().db_path
    const schema = getDbSchema(dbPath)
    const now = new Date()
    const dd = String(now.getDate()).padStart(2, "0")
    const mm = String(now.getMonth() + 1).padStart(2, "0")
    const yyyy = now.getFullYear()

    const adminLlmCfg = getAdminDirectLlmConfig()

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
        sql = (await complete(sqlPrompt, { flow: "admin", llmConfig: adminLlmCfg }) || "").trim().replace(/^```\w*\n?|\n?```$/g, "").trim()
    } catch {
        return "LLM unavailable for SQL generation. Raw data:\n" + dbContext
    }

    if (!sql || !/^SELECT\b/i.test(sql)) {
        // Fallback to summary-based answer
        return await summaryFallback(resolvedRequest, dbContext, conversationId)
    }

    logger.info({ sql }, "admin query: generated SQL")

    // Step 2: execute SQL
    let rows
    const db = new Database(dbPath, { readonly: true })
    try {
        rows = db.prepare(sql).all()
    } catch (err) {
        logger.warn({ err, sql }, "admin query: SQL execution failed, falling back")
        return await summaryFallback(resolvedRequest, dbContext, conversationId)
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
        const flowCfg = getAdminDirectLlmConfig()
        const messages = prepareRequest(answerPrompt, "admin", {
            systemContext: `You are an admin assistant for ${businessName}. Be concise.${currencyHint}`,
            conversationState: conversationState.getState("admin", conversationId),
            history: flowMemory.getHistory("admin", conversationId),
            resolvedRequest,
        })
        return await complete(messages, { flow: "admin", llmConfig: flowCfg }) || `Query returned ${rows.length} rows:\n${JSON.stringify(rows, null, 2)}`
    } catch {
        return `Query returned ${rows.length} rows:\n${JSON.stringify(rows, null, 2)}`
    }
}

async function summaryFallback(resolvedRequest, dbContext, conversationId = getActiveWorkspace()) {
    const question = resolvedRequest.effectiveMessage || resolvedRequest.originalMessage || ""
    const businessName = getAdminCfg().business_name || "the business"
    const adminLlmCfg = getAdminDirectLlmConfig()
    const prompt = `You are an admin assistant for ${businessName}.
Answer the admin's question using ONLY the data provided below. Be concise and use numbers/facts directly.
Do not make up data. If something is not in the data, say so.

${dbContext}

Admin question: ${question}
Answer:`
    try {
        const flowCfg = adminLlmCfg
        const messages = prepareRequest(prompt, "admin", {
            dynamicContext: dbContext,
            conversationState: conversationState.getState("admin", conversationId),
            history: flowMemory.getHistory("admin", conversationId),
            resolvedRequest,
        })
        return await complete(messages, { flow: "admin", llmConfig: flowCfg }) || "No response from LLM."
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

    const text = String(task || "").toLowerCase()
    const selected = new Set()
    const addIfPresent = (tableName) => { if (allTables.includes(tableName)) selected.add(tableName) }

    if (/\bexpense|expenses|income|grocery|purchase|fuel|rent|salary\b/.test(text)) addIfPresent("expenses")
    if (/\border|orders|delivery|deliveries|invoice|payment|paid|unpaid|cart|customer order\b/.test(text)) addIfPresent("orders")
    if (/\bsubscription|subscriptions|meal plan|plan|renewal|expiry|expires\b/.test(text)) addIfPresent("subscriptions")
    if (/\bdelivery|deliveries|delivered|meal delivered\b/.test(text)) addIfPresent("subscription_deliveries")
    if (/\bmenu|menus|dish|dishes|item|items|calorie|protein|veg|non-veg|nonveg\b/.test(text)) {
        addIfPresent("menu_sections")
        addIfPresent("menu_items")
        addIfPresent("corporate_menu_sections")
        addIfPresent("corporate_menu_items")
    }
    if (/\bcoupon|coupons|discount|promo|offer|free delivery\b/.test(text)) addIfPresent("coupons")
    if (/\buser|users|customer|customers|mobile|address|diet|goal\b/.test(text)) addIfPresent("users")
    if (/\bbulk|corporate\b/.test(text)) addIfPresent("bulk_orders")
    if (/\bkitchen|closure|closed\b/.test(text)) {
        addIfPresent("app_state")
        addIfPresent("kitchen_closures")
    }

    return selected.size ? Array.from(selected) : allTables
}

async function handleAdmin(payload, options = {}) {
    const flow = options.flow || "admin" // default to admin flow
    if (!payload) {
        const access = getFlowAccessConfig(flow)
        return `⚙️ ${flow === "agent" ? "Agent" : "Admin"} ready. Usage: \`${access.keyword} ${access.pin ? "<pin> " : ""}<command or question>\``
    }
    
    const workspaceId = options.workspaceId || getActiveWorkspace()
    const user = options.user || {}
    const role = user.role || options.role || getAdminCfg()?.role || "super_admin"
    const mode = user.mode || "full"
    const flowCfg = getFlowConfig(flow)

    logger.info({ payload, user: user.name, role, mode, flow }, "admin: handling request")

    const allowedTools = getAllowedToolsForFlow(flow)

    if (flow === "admin" && !allowedTools.includes("approvals") && /^approvals\b/i.test(payload)) {
        // approvals not explicitly in default tools, but let's keep it functional unless blocked
    }

    if (/^approvals\b/i.test(payload)) {
        if (flow === "admin" && !allowedTools.includes("query_db")) return "⛔ Your tool allowlist does not include query/approval access."
        return await finalizeAdminResponse(payload, { ...options, workspaceId, user, role }, async () => {
            const approvals = listApprovals("pending", workspaceId)
            if (!approvals.length) return "No pending approvals."
            return approvals.slice(0, 10).map(a =>
                `• ${a.id} | workspace: ${a.workspaceId} | tool: ${a.tool} | worker: ${a.worker} | created: ${a.createdAt}\n  task: ${a.task}`
            ).join("\n\n")
        })
    }

    if (/^approve\s+/i.test(payload)) {
        if (mode === "query_only") return "⛔ Your access level does not allow approvals."
        if (flow === "admin" && !allowedTools.includes("query_db")) return "⛔ Your tool allowlist does not include approval access."
        return await finalizeAdminResponse(payload, { ...options, workspaceId, user, role }, async () => {
            const id = payload.replace(/^approve\s+/i, "").trim()
            const approval = approveRequest(id, workspaceId)
            if (!approval) return `Approval ${id} not found.`
            return `✅ Approved ${approval.id} for ${approval.tool}.\nRerun the task and include token ${approval.id} in the request.`
        })
    }

    const adminState = flow === "admin" ? conversationState.getState("admin", options.phone || workspaceId) : null
    const resolvedAdmin = flow === "admin"
        ? resolveFollowUp({ flow: "admin", message: payload, conversationState: adminState })
        : { message: payload, resolved: false }
    const effectivePayload = resolvedAdmin.message || payload
    const resolvedRequest = buildResolvedRequest({
        flow: "admin",
        originalMessage: payload,
        effectiveMessage: effectivePayload,
        conversationState: adminState,
        resolution: resolvedAdmin,
    })

    const adminExecution = decideAdminExecution({ flow, flowConfig: flowCfg, payload })

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
            return await finalizeAdminResponse(payload, { ...options, workspaceId, user, role }, async () =>
                await dispatchAgentTask(task, { workspaceId, role, noContext: isExplicitAgent, flow, backend: flowCfg.backend })
            )
        }
    }

    // Auto-route mutations to agentic mode
    if (/\b(add|record|insert|update|change|set|delete|remove|mark)\b/i.test(payload)) {
        if (mode === "query_only" || mode === "shell_only") return `⛔ Your access level (${mode}) does not allow mutations.`
        logger.info({ payload, user: user.name }, "admin: mutation detected, routing to agent")
        return await finalizeAdminResponse(payload, { ...options, workspaceId, user, role }, async () =>
            await dispatchAgentTask(payload, { workspaceId, role, flow, backend: flowCfg.backend })
        )
    }

    if (adminExecution.mode === "backend") {
        return await finalizeAdminResponse(payload, { ...options, workspaceId, user, role }, async () =>
            await answerAdminViaConfiguredMode(resolvedRequest, workspaceId, options.phone || workspaceId)
        )
    }

    if (looksLikeShell(payload)) {
        if (mode === "query_only" || mode === "agent_only") return `⛔ Your access level (${mode}) does not allow shell commands.`
        if (flow === "admin" && !allowedTools.includes("shell")) return "⛔ Your tool allowlist does not include shell commands."
        return await finalizeAdminResponse(payload, { ...options, workspaceId, user, role }, async () => {
            const result = await runShell(payload)
            return `\`\`\`\n${result}\n\`\`\``
        })
    }

    // Natural language — governance check then dynamic SQL via LLM
    if (flow === "admin" && !allowedTools.includes("query_db")) return "⛔ Your tool allowlist does not include database queries."
    const auth = authorizeToolCall({ role, worker: "operator", tool: "query_db", task: effectivePayload, workspaceId })
    if (!auth.allowed) return `⛔ ${auth.reason}${auth.approvalHint ? "\n" + auth.approvalHint : ""}`

    return await finalizeAdminResponse(payload, { ...options, workspaceId, user, role }, async () => {
        const dbContext = buildDbContext(workspaceId)
        return await queryWithLlm(resolvedRequest, dbContext, workspaceId, options.phone || workspaceId)
    })
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
    getAllowedToolsForFlow,
    getFlowAccessConfig,
    buildDbContext, 
    getDbSchema,
    selectRelevantTables
}
