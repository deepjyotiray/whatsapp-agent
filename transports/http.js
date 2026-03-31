"use strict"

const http     = require("http")
const crypto   = require("crypto")
const fs       = require("fs")
const path     = require("path")
const agentChain = require("../runtime/agentChain")
const settings = require("../config/settings.json")
const logger   = require("../gateway/logger")
const {
    loadProfile,
    saveProfile,
    generateDraftFromProfile,
    listDraftFiles,
    promoteDraft,
    getWorkspaceSummary,
    setActiveWorkspace,
} = require("../setup/profileService")
const { chatWithDraft } = require("../setup/chatSandbox")
const { getGovernanceSnapshot, updatePolicy } = require("../gateway/adminGovernance")
const { listApprovals, approveRequest } = require("../gateway/adminApprovals")
const { handleAdmin, handleAdminImage, getShellPatterns, getUsers } = require("../gateway/admin")
const { listWorkers } = require("../gateway/adminWorkers")
const { loadNotes, saveNotes, generateNotes } = require("../core/dataModelNotes")
const { getPromptGuides, getPromptGuide, addCustomGuide, removeCustomGuide } = require("../core/promptGuides")
const { getActiveWorkspace, listWorkspaceIds } = require("../core/workspace")
const { buildPreview, buildWorkflowPreview, approveAndExecute, reject: rejectPreview, listPending, getPending, getEntry, setExecutionPolicy, getExecutionPolicy, setAutoMode, isAutoMode } = require("../runtime/previewEngine")
const workflowStore = require("../runtime/workflowStore")
const debugInterceptor = require("../runtime/debugInterceptor")
const { clearOpenClawSessions } = require("../gateway/adminAgent")
const cartStore = require("../tools/cartStore")
const yaml = require("js-yaml")
const { normalizeCustomerExecutionConfig, validateCustomerExecutionConfig } = require("../runtime/customerExecutionConfig")
const { listCustomerBackendPresets, getCustomerBackendPreset } = require("../runtime/customerBackendPresets")
const { summarizeCustomerLog } = require("../runtime/customerObservability")

const PORT   = Number(process.env.HTTP_PORT) || settings.transports?.http?.port || 3010
const SECRET = settings.api.secret
const PUBLIC_DIR = path.resolve(__dirname, "../public")
const setupConfig = settings.setup || {}
const SETUP_USER = process.env.SETUP_USER || setupConfig.username || "linkedin"
const SETUP_PASS = process.env.SETUP_PASS || setupConfig.password || "community"
const SETUP_HOSTS = String(process.env.SETUP_HOST || setupConfig.hosts || "localhost").split(",").map(h => h.trim().toLowerCase()).filter(Boolean)
const SETUP_COOKIE = "secureai_session"
const SESSION_TTL_MS = 1000 * 60 * 60 * 12
const SETUP_BRAND = process.env.SETUP_BRAND || setupConfig.brand || "SecureAI"
const SETUP_LOGIN_TITLE = process.env.SETUP_LOGIN_TITLE || setupConfig.login_title || "Enter the agent workspace."
const SETUP_LOGIN_LEDE = process.env.SETUP_LOGIN_LEDE || setupConfig.login_lede || "Use the branded entry screen to reach your business agent console."
const SETUP_LOGIN_SUBMIT = process.env.SETUP_LOGIN_SUBMIT || setupConfig.login_submit || "Continue"
const OPENCLAW_HOME = path.resolve(process.env.HOME || "", ".openclaw")

function readBody(req) {
    return new Promise((resolve, reject) => {
        let body = ""
        req.on("data", chunk => { body += chunk })
        req.on("end", () => {
            try { resolve(JSON.parse(body)) } catch { reject(new Error("invalid_json")) }
        })
    })
}

function sendJson(res, code, payload) {
    res.writeHead(code).end(JSON.stringify(payload))
}

function contentType(filePath) {
    if (filePath.endsWith(".html")) return "text/html; charset=utf-8"
    if (filePath.endsWith(".css")) return "text/css; charset=utf-8"
    if (filePath.endsWith(".js")) return "application/javascript; charset=utf-8"
    if (filePath.endsWith(".json")) return "application/json; charset=utf-8"
    return "text/plain; charset=utf-8"
}

function assetVersion() {
    try {
        const root = path.join(PUBLIC_DIR, "setup")
        let maxMtime = 0
        const stack = [root]
        while (stack.length) {
            const dir = stack.pop()
            const entries = fs.readdirSync(dir, { withFileTypes: true })
            for (const entry of entries) {
                if (entry.name.startsWith(".")) continue
                const full = path.join(dir, entry.name)
                if (entry.isDirectory()) {
                    stack.push(full)
                    continue
                }
                const mtime = fs.statSync(full).mtimeMs | 0
                if (mtime > maxMtime) maxMtime = mtime
            }
        }
        return String(maxMtime || 0)
    } catch {
        return "0"
    }
}
const ASSET_V = assetVersion()

function serveFile(res, filePath) {
    if (!fs.existsSync(filePath)) {
        sendJson(res, 404, { error: "not_found" })
        return
    }
    const ct = contentType(filePath)
    res.setHeader("Content-Type", ct)
    let content = fs.readFileSync(filePath)
    if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache")
        content = content.toString("utf8")
            .replace(/(\.js)("|')/g, `$1?v=${ASSET_V}$2`)
            .replace(/(\.css)("|')/g, `$1?v=${ASSET_V}$2`)
    }
    res.writeHead(200).end(content)
}

function unauthorizedSetup(res) {
    sendJson(res, 401, { error: "setup_auth_required" })
}

function cookieSecureFlag(req) {
    const forwardedProto = String(req.headers["x-forwarded-proto"] || "").toLowerCase()
    return forwardedProto === "https" || hostName(req) === "localhost"
}

function parseCookies(req) {
    const header = String(req.headers.cookie || "")
    return Object.fromEntries(
        header
            .split(/;\s*/)
            .filter(Boolean)
            .map(entry => {
                const idx = entry.indexOf("=")
                if (idx === -1) return [entry, ""]
                return [entry.slice(0, idx), decodeURIComponent(entry.slice(idx + 1))]
            })
    )
}

function createSessionToken(identity = SETUP_USER) {
    const expiresAt = Date.now() + SESSION_TTL_MS
    const safeIdentity = String(identity || SETUP_USER).trim().slice(0, 120) || SETUP_USER
    const payload = `${safeIdentity}:${expiresAt}`
    const signature = crypto.createHmac("sha256", SECRET).update(payload).digest("hex")
    return Buffer.from(`${payload}:${signature}`).toString("base64url")
}

function isSetupAuthorized(req) {
    const token = parseCookies(req)[SETUP_COOKIE]
    if (!token) return false
    try {
        const decoded = Buffer.from(token, "base64url").toString("utf8")
        const parts = decoded.split(":")
        if (parts.length !== 3) return false
        const [username, expiresAtRaw, signature] = parts
        const payload = `${username}:${expiresAtRaw}`
        const expected = crypto.createHmac("sha256", SECRET).update(payload).digest("hex")
        const expiresAt = Number(expiresAtRaw)
        if (!username || !Number.isFinite(expiresAt)) return false
        if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false
        return !!username && expiresAt > Date.now()
    } catch {
        return false
    }
}

function clearSession(res) {
    res.setHeader("Set-Cookie", `${SETUP_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
}

function setSession(req, res, identity) {
    const token = createSessionToken(identity)
    const secure = cookieSecureFlag(req) ? "; Secure" : ""
    res.setHeader("Set-Cookie", `${SETUP_COOKIE}=${token}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`)
}

function hostName(req) {
    return String(req.headers.host || "").toLowerCase().split(":")[0]
}

function requestUrl(req) {
    return new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`)
}

function getWorkspaceFromReq(req, fallback = getActiveWorkspace()) {
    return requestUrl(req).searchParams.get("workspace") || fallback
}

function safeReadJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback
        return JSON.parse(fs.readFileSync(filePath, "utf8"))
    } catch {
        return fallback
    }
}

function readRecentFileLines(filePath, limit = 80) {
    try {
        if (!fs.existsSync(filePath)) return []
        const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean)
        return lines.slice(-limit)
    } catch {
        return []
    }
}

function getOpenClawSessionMap(agentId = "agent") {
    return safeReadJson(path.join(OPENCLAW_HOME, "agents", agentId, "sessions", "sessions.json"), {}) || {}
}

function listOpenClawSessions(agentId = "agent") {
    const sessions = getOpenClawSessionMap(agentId)
    return Object.entries(sessions)
        .map(([sessionKey, meta]) => ({
            sessionKey,
            sessionId: meta.sessionId || "",
            updatedAt: meta.updatedAt || 0,
            status: meta.status || "unknown",
            model: meta.model || meta.modelId || "",
            provider: meta.modelProvider || "",
            sessionFile: meta.sessionFile || path.join(OPENCLAW_HOME, "agents", agentId, "sessions", `${meta.sessionId}.jsonl`),
        }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

function readOpenClawSessionHistory(agentId = "agent", sessionKey = "agent:agent:main", limit = 120) {
    const sessions = getOpenClawSessionMap(agentId)
    const meta = sessions[sessionKey]
    if (!meta) return { sessionKey, found: false, messages: [] }
    const sessionFile = meta.sessionFile || path.join(OPENCLAW_HOME, "agents", agentId, "sessions", `${meta.sessionId}.jsonl`)
    const lines = readRecentFileLines(sessionFile, Math.max(limit * 3, 200))
    const parsed = []
    for (const line of lines) {
        try {
            parsed.push(JSON.parse(line))
        } catch {}
    }
    const messages = parsed
        .filter(entry => entry.type === "message" && entry.message)
        .map(entry => {
            const role = entry.message.role || "unknown"
            const content = Array.isArray(entry.message.content)
                ? entry.message.content
                    .filter(part => part && (part.type === "text" || part.type === "input_text" || part.type === "output_text"))
                    .map(part => String(part.text || "").trim())
                    .filter(Boolean)
                    .join("\n\n")
                : String(entry.message.content || "").trim()
            return {
                id: entry.id || "",
                timestamp: entry.timestamp || entry.message.timestamp || "",
                role,
                content,
                provider: entry.message.provider || "",
                model: entry.message.model || "",
            }
        })
        .filter(msg => msg.content)
        .slice(-limit)
    return {
        sessionKey,
        found: true,
        sessionId: meta.sessionId || "",
        updatedAt: meta.updatedAt || 0,
        model: meta.model || "",
        provider: meta.modelProvider || "",
        messages,
    }
}

function getOpenClawSummary() {
    const openclawConfig = safeReadJson(path.join(OPENCLAW_HOME, "openclaw.json"), {}) || {}
    const studioConfig = safeReadJson(path.join(OPENCLAW_HOME, "openclaw-studio", "settings.json"), {}) || {}
    const pairedDevices = safeReadJson(path.join(OPENCLAW_HOME, "devices", "paired.json"), {}) || {}
    const pendingDevices = safeReadJson(path.join(OPENCLAW_HOME, "devices", "pending.json"), {}) || {}
    const approvals = safeReadJson(path.join(OPENCLAW_HOME, "exec-approvals.json"), {}) || {}
    const agentModels = safeReadJson(path.join(OPENCLAW_HOME, "agents", "agent", "models.json"), {}) || {}
    const adminModels = safeReadJson(path.join(OPENCLAW_HOME, "agents", "admin", "models.json"), {}) || {}
    const agentAuthProfiles = safeReadJson(path.join(OPENCLAW_HOME, "agents", "agent", "auth-profiles.json"), {}) || {}
    const cronJobs = safeReadJson(path.join(OPENCLAW_HOME, "cron", "jobs.json"), {}) || {}
    const gatewayLog = readRecentFileLines(path.join(OPENCLAW_HOME, "logs", "gateway.log"), 40)
    const agentSessions = listOpenClawSessions("agent")
    const adminSessions = listOpenClawSessions("admin")

    const deviceRows = Object.values(pairedDevices).map(device => ({
        clientId: device.clientId || "unknown",
        clientMode: device.clientMode || "unknown",
        platform: device.platform || "unknown",
        role: device.role || "unknown",
        createdAtMs: device.createdAtMs || 0,
        approvedAtMs: device.approvedAtMs || 0,
    }))

    return {
        gateway: {
            port: openclawConfig.gateway?.port || null,
            mode: openclawConfig.gateway?.mode || "",
            bind: openclawConfig.gateway?.bind || "",
            authMode: openclawConfig.gateway?.auth?.mode || "",
            controlUiOrigins: openclawConfig.gateway?.controlUi?.allowedOrigins || [],
            localUrl: studioConfig.gateway?.url || "",
            focused: studioConfig.focused || {},
        },
        agentIdentity: {
            id: "agent",
            workspace: openclawConfig.agents?.list?.find(agent => agent.id === "agent")?.workspace || "",
            model: openclawConfig.agents?.list?.find(agent => agent.id === "agent")?.model || openclawConfig.agents?.defaults?.model?.primary || "",
        },
        sessions: {
            agent: agentSessions,
            admin: adminSessions,
        },
        devices: {
            pairedCount: Object.keys(pairedDevices).length,
            pendingCount: Object.keys(pendingDevices).length,
            paired: deviceRows,
        },
        approvals: {
            socketPath: approvals.socket?.path || "",
            agentCount: Object.keys(approvals.agents || {}).length,
        },
        authProfiles: {
            agentCount: Object.keys(agentAuthProfiles.profiles || {}).length,
            lastGood: agentAuthProfiles.lastGood || {},
        },
        cron: {
            jobCount: Array.isArray(cronJobs.jobs) ? cronJobs.jobs.length : 0,
            jobs: Array.isArray(cronJobs.jobs) ? cronJobs.jobs : [],
        },
        models: {
            agent: agentModels.providers || {},
            admin: adminModels.providers || {},
        },
        logs: gatewayLog,
    }
}

function getSetupAuthConfig() {
    return {
        mode: "password",
        brand: SETUP_BRAND,
        title: SETUP_LOGIN_TITLE,
        lede: SETUP_LOGIN_LEDE,
        submitLabel: SETUP_LOGIN_SUBMIT,
        requiresPassword: true,
        requiresUsername: true,
    }
}

function redirectToLogin(req, res) {
    const url = requestUrl(req)
    const next = `${url.pathname}${url.search}`
    res.writeHead(302, { Location: `/login?next=${encodeURIComponent(next)}` })
    res.end()
}

const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json")

    const host = hostName(req)
    const url = requestUrl(req)
    const pathname = url.pathname
    const setupHost = SETUP_HOSTS.includes(host)

    const PAGE_MAP = {
        "/": "dashboard.html",
        "/profile": "profile.html",
        "/chat": "chat.html",
        "/agent-chat": "agent-chat.html",
        "/admin": "admin.html",
        "/tools": "tools.html",
        "/intercept": "intercept-v2.html",
        "/control": "control.html",
        "/models": "models.html",
        "/setup": "dashboard.html",
        "/setup/intercept": "intercept-v2.html",
        "/setup/control": "control.html",
    }

    const isSetupPath = pathname.startsWith("/setup") || setupHost || PAGE_MAP[pathname] || pathname === "/login" || pathname.startsWith("/agent/") || pathname.startsWith("/governance")
    const loginAsset = req.method === "GET" && (
        pathname === "/login" ||
        pathname === "/setup/auth/config" ||
        pathname === "/setup/styles.css" ||
        pathname === "/setup/login.js" ||
        pathname.startsWith("/setup/assets/")
    )

    if (isSetupPath) {
        if (!loginAsset && !(req.method === "POST" && pathname === "/setup/login") && !isSetupAuthorized(req)) {
            if (req.method === "GET" && PAGE_MAP[pathname]) {
                redirectToLogin(req, res)
                return
            }
            unauthorizedSetup(res)
            return
        }
    }

    if (req.method === "GET" && pathname === "/login") {
        serveFile(res, path.join(PUBLIC_DIR, "setup", "login.html"))
        return
    }

    if (req.method === "GET" && pathname === "/setup/auth/config") {
        sendJson(res, 200, getSetupAuthConfig())
        return
    }

    if (req.method === "GET" && PAGE_MAP[pathname]) {
        serveFile(res, path.join(PUBLIC_DIR, "setup", PAGE_MAP[pathname]))
        return
    }

    if (req.method === "GET" && pathname.startsWith("/setup/") && !pathname.startsWith("/setup/assets/")) {
        const rel = pathname.replace("/setup/", "")
        const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "")
        const filePath = path.join(PUBLIC_DIR, "setup", safe)
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
            serveFile(res, filePath)
            return
        }
    }

    if (req.method === "GET" && pathname.startsWith("/setup/assets/")) {
        const rel = pathname.replace("/setup/assets/", "")
        const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "")
        serveFile(res, path.join(PUBLIC_DIR, "setup", safe))
        return
    }

    if (req.method === "POST" && pathname === "/setup/login") {
        try {
            const body = await readBody(req)
            const username = String(body.username || "").trim()
            const password = String(body.password || "")
            if (username !== SETUP_USER || password !== SETUP_PASS) {
                clearSession(res)
                sendJson(res, 401, { error: "invalid_credentials" })
                return
            }
            setSession(req, res, username)
            sendJson(res, 200, { ok: true, next: String(body.next || "") })
        } catch (err) {
            logger.error({ err }, "setup login failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/logout") {
        clearSession(res)
        sendJson(res, 200, { ok: true })
        return
    }

    if (req.method === "GET" && pathname === "/setup/profile") {
        res.setHeader("Cache-Control", "no-store")
        const workspaceId = getWorkspaceFromReq(req)
        const profile = loadProfile(workspaceId)
        logger.info({ workspaceId, businessName: profile.businessName }, "profile loaded")
        sendJson(res, 200, {
            profile,
            draftFiles: listDraftFiles(workspaceId),
            ...getWorkspaceSummary(),
        })
        return
    }

    if (req.method === "POST" && pathname === "/setup/profile") {
        try {
            const body = await readBody(req)
            const profile = saveProfile(body, body.workspaceId)
            sendJson(res, 200, { ok: true, profile })
        } catch (err) {
            logger.error({ err }, "setup profile save failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/generate") {
        try {
            const body = await readBody(req)
            const profile = saveProfile(body, body.workspaceId)
            const result = await generateDraftFromProfile(profile)
            sendJson(res, 200, {
                ok: true,
                slug: result.slug,
                workspaceId: profile.workspaceId,
                draftFiles: listDraftFiles(profile.workspaceId),
                intents: Object.keys(result.manifestObj?.intents || {}),
                faqTopics: (result.faqObj?.faqs || []).map(f => f.topic),
                keywordCount: result.policyObj?.domain_keywords?.length || 0,
            })
        } catch (err) {
            logger.error({ err }, "setup generate failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/promote") {
        try {
            const body = await readBody(req).catch(() => ({}))
            const result = promoteDraft(body.workspaceId || getActiveWorkspace())
            sendJson(res, 200, { ok: true, ...result })
        } catch (err) {
            logger.error({ err }, "setup promote failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/governance/policy") {
        try {
            const body = await readBody(req)
            const workspaceId = body.workspaceId || getActiveWorkspace()
            const policy = updatePolicy(body, workspaceId)
            sendJson(res, 200, { ok: true, policy })
        } catch (err) {
            logger.error({ err }, "setup governance policy update failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "DELETE" && pathname.startsWith("/setup/governance/tool/")) {
        try {
            const toolName = decodeURIComponent(pathname.replace("/setup/governance/tool/", ""))
            const workspaceId = requestUrl(req).searchParams.get("workspaceId") || getActiveWorkspace()
            const snapshot = getGovernanceSnapshot(settings.admin?.role, workspaceId)
            if (!snapshot.tools[toolName]) { sendJson(res, 404, { error: `tool '${toolName}' not in governance` }); return }
            delete snapshot.tools[toolName]
            const policy = updatePolicy({ tools: snapshot.tools }, workspaceId)
            sendJson(res, 200, { ok: true, deleted: toolName, tools: policy.tools })
        } catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    if (req.method === "POST" && pathname === "/setup/governance/read-only") {
        try {
            const { enabled, workspaceId: wid } = await readBody(req)
            const workspaceId = wid || getActiveWorkspace()
            const snapshot = getGovernanceSnapshot(settings.admin?.role, workspaceId)
            const patch = {}
            for (const [name, cfg] of Object.entries(snapshot.tools)) {
                if (cfg.mutating) patch[name] = { ...cfg, approval: enabled ? "explicit" : (cfg._origApproval || "task_intent") }
            }
            const policy = updatePolicy({ tools: patch }, workspaceId)
            sendJson(res, 200, { ok: true, enabled, tools: policy.tools })
        } catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    if (req.method === "GET" && pathname === "/setup/agent/prompts") {
        const workspaceId = url.searchParams.get("workspaceId") || getActiveWorkspace()
        const id = url.searchParams.get("id")
        if (id) {
            const result = getPromptGuide(id, workspaceId)
            if (!result) { sendJson(res, 404, { error: `guide '${id}' not found` }); return }
            sendJson(res, 200, { ok: true, ...result })
        } else {
            sendJson(res, 200, { ok: true, ...getPromptGuides(workspaceId) })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/agent/prompts") {
        try {
            const body = await readBody(req)
            const workspaceId = body.workspaceId || getActiveWorkspace()
            if (!body.id || !body.prompt) { sendJson(res, 400, { error: "id and prompt required" }); return }
            const guide = addCustomGuide(workspaceId, body)
            sendJson(res, 200, { ok: true, workspaceId, guide })
        } catch (err) {
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "DELETE" && pathname === "/setup/agent/prompts") {
        try {
            const body = await readBody(req)
            const workspaceId = body.workspaceId || getActiveWorkspace()
            if (!body.id) { sendJson(res, 400, { error: "id required" }); return }
            const removed = removeCustomGuide(workspaceId, body.id)
            sendJson(res, 200, { ok: true, removed })
        } catch (err) {
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "GET" && pathname === "/setup/agent/notes") {
        const workspaceId = (url.searchParams.get("workspaceId") || getActiveWorkspace())
        sendJson(res, 200, { ok: true, workspaceId, notes: loadNotes(workspaceId) })
        return
    }

    if (req.method === "POST" && pathname === "/setup/agent/notes") {
        try {
            const body = await readBody(req)
            const workspaceId = body.workspaceId || getActiveWorkspace()
            if (!body.notes) { sendJson(res, 400, { error: "notes field required" }); return }
            const notes = saveNotes(workspaceId, body.notes)
            sendJson(res, 200, { ok: true, workspaceId, notes })
        } catch (err) {
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/agent/notes/regenerate") {
        try {
            const body = await readBody(req)
            const workspaceId = body.workspaceId || getActiveWorkspace()
            const notes = await generateNotes(workspaceId)
            sendJson(res, 200, { ok: true, workspaceId, notes })
        } catch (err) {
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/workspace/select") {
        try {
            const { workspaceId } = await readBody(req)
            if (!workspaceId) {
                sendJson(res, 400, { error: "workspace id required" })
                return
            }
            const activeWorkspace = setActiveWorkspace(workspaceId)
            // hot-swap agent manifest for the selected workspace
            const { invalidateProfileCache } = require("../runtime/executor")
            invalidateProfileCache()
            const profile = loadProfile(workspaceId)
            const agentsDir = path.resolve(__dirname, "../agents")
            const byId = path.join(agentsDir, `${workspaceId}.yml`)
            const byProfile = profile.agentManifest ? path.resolve(__dirname, "..", profile.agentManifest) : null
            const manifestPath = fs.existsSync(byId) ? byId : (byProfile && fs.existsSync(byProfile)) ? byProfile : null
            if (manifestPath) {
                agentChain.loadAgent(manifestPath)
                logger.info({ workspaceId, manifestPath }, "workspace switch: agent reloaded")
            }
            sendJson(res, 200, { ok: true, activeWorkspace, agentLoaded: !!manifestPath, ...getWorkspaceSummary() })
        } catch (err) {
            logger.error({ err }, "setup workspace select failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/chat") {
        try {
            const { phone, message, workspaceId, mode } = await readBody(req)
            if (!phone || !message) {
                sendJson(res, 400, { error: "phone and message required" })
                return
            }
            let response, source
            if (mode === "live") {
                response = await agentChain.execute(message, phone)
                source = "live"
            } else {
                const profile = loadProfile(workspaceId || getActiveWorkspace())
                const preview = mode === "draft" ? await chatWithDraft(profile, message, phone) : (await chatWithDraft(profile, message, phone))
                if (preview != null) {
                    response = preview; source = "draft"
                } else {
                    response = await agentChain.execute(message, phone)
                    source = "live"
                }
            }
            sendJson(res, 200, { ok: true, response, source })
        } catch (err) {
            logger.error({ err }, "setup chat failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "GET" && pathname === "/setup/governance") {
        try {
            const workspaceId = getWorkspaceFromReq(req)
            sendJson(res, 200, getGovernanceSnapshot(settings.admin?.role, workspaceId))
        } catch (err) {
            logger.error({ err }, "setup governance failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "GET" && pathname === "/setup/approvals") {
        try {
            const workspaceId = getWorkspaceFromReq(req)
            sendJson(res, 200, { approvals: listApprovals("", workspaceId) })
        } catch (err) {
            logger.error({ err }, "setup approvals failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/approvals/approve") {
        try {
            const { id, workspaceId } = await readBody(req)
            if (!id) {
                sendJson(res, 400, { error: "approval id required" })
                return
            }
            const approval = approveRequest(id, workspaceId || getActiveWorkspace())
            if (!approval) {
                sendJson(res, 404, { error: "approval_not_found" })
                return
            }
            sendJson(res, 200, { ok: true, approval })
        } catch (err) {
            logger.error({ err }, "setup approval action failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "GET" && pathname === "/setup/admin/users") {
        sendJson(res, 200, { ok: true, users: getUsers() })
        return
    }

    if (req.method === "PUT" && pathname === "/setup/admin/users") {
        try {
            const { users } = await readBody(req)
            if (!Array.isArray(users)) { sendJson(res, 400, { error: "users must be an array" }); return }
            const cleaned = users.filter(u => u.phone).map(u => ({
                phone: String(u.phone).trim(),
                name: String(u.name || "").trim(),
                role: u.role || "operator",
                mode: u.mode || "full",
                pin: u.pin !== undefined ? String(u.pin) : "",
            }))
            const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../config/settings.json"), "utf8"))
            cfg.admin.users = cleaned
            fs.writeFileSync(path.resolve(__dirname, "../config/settings.json"), JSON.stringify(cfg, null, 2))
            delete require.cache[require.resolve("../config/settings.json")]
            sendJson(res, 200, { ok: true, users: cleaned })
        } catch (err) {
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "GET" && pathname === "/setup/admin/shell-patterns") {
        sendJson(res, 200, { ok: true, patterns: getShellPatterns() })
        return
    }

    if (req.method === "PUT" && pathname === "/setup/admin/shell-patterns") {
        try {
            const { patterns } = await readBody(req)
            if (!Array.isArray(patterns)) { sendJson(res, 400, { error: "patterns must be an array" }); return }
            const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../config/settings.json"), "utf8"))
            cfg.admin.shell_patterns = patterns.map(p => String(p).trim()).filter(Boolean)
            fs.writeFileSync(path.resolve(__dirname, "../config/settings.json"), JSON.stringify(cfg, null, 2))
            // bust require cache so getSettings() picks up new values
            delete require.cache[require.resolve("../config/settings.json")]
            sendJson(res, 200, { ok: true, patterns: cfg.admin.shell_patterns })
        } catch (err) {
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    // ── LLM Config ────────────────────────────────────────────────────────────

    if (req.method === "GET" && pathname === "/setup/llm/config") {
        const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../config/settings.json"), "utf8"))
        const customer = cfg.llm || cfg.ollama || {}
        const admin = cfg.admin?.agent_llm || {}
        const agent = cfg.agent_llm || {}
        sendJson(res, 200, {
            customer: { provider: customer.provider || "openai", model: customer.model || "", url: customer.url || "", api_key: customer.api_key ? "••••" + customer.api_key.slice(-4) : "" },
            admin:    { 
                model: admin.model || "", 
                url: admin.url || "", 
                api_key: admin.api_key ? "••••" + admin.api_key.slice(-4) : "",
                keyword: cfg.admin?.keyword || "ray",
                tools: cfg.admin?.tools || ["query_db", "shell"]
            },
            agent:    { 
                model: agent.model || "", 
                url: agent.url || "", 
                api_key: agent.api_key ? "••••" + agent.api_key.slice(-4) : "",
                keyword: cfg.admin?.agent_keyword || "agent",
                tools: cfg.admin?.agent_tools || ["run_shell", "mac_automation", "query_db", "send_whatsapp", "http_request", "open_browser", "screenshot", "click", "fill", "skill_call"]
            },
            agent_backend: cfg.admin?.agent_backend || "local",
        })
        return
    }

    if (req.method === "PUT" && pathname === "/setup/llm/config") {
        try {
            const body = await readBody(req)
            const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../config/settings.json"), "utf8"))
            if (body.customer) {
                if (!cfg.llm) cfg.llm = {}
                if (body.customer.provider !== undefined) cfg.llm.provider = body.customer.provider
                if (body.customer.model !== undefined) cfg.llm.model = body.customer.model
                if (body.customer.url !== undefined) cfg.llm.url = body.customer.url || undefined
                if (body.customer.api_key && !body.customer.api_key.startsWith("••••")) cfg.llm.api_key = body.customer.api_key
            }
            if (body.admin) {
                if (!cfg.admin) cfg.admin = {}
                if (!cfg.admin.agent_llm) cfg.admin.agent_llm = {}
                if (body.admin.model !== undefined) cfg.admin.agent_llm.model = body.admin.model
                if (body.admin.url !== undefined) cfg.admin.agent_llm.url = body.admin.url || undefined
                if (body.admin.api_key && !body.admin.api_key.startsWith("••••")) cfg.admin.agent_llm.api_key = body.admin.api_key
                if (body.admin.keyword !== undefined) cfg.admin.keyword = body.admin.keyword
                if (body.admin.tools !== undefined) cfg.admin.tools = Array.isArray(body.admin.tools) ? body.admin.tools : String(body.admin.tools).split(",").map(s => s.trim()).filter(Boolean)
            }
            if (body.agent) {
                if (!cfg.agent_llm) cfg.agent_llm = {}
                if (body.agent.model !== undefined) cfg.agent_llm.model = body.agent.model
                if (body.agent.url !== undefined) cfg.agent_llm.url = body.agent.url || undefined
                if (body.agent.api_key && !body.agent.api_key.startsWith("••••")) cfg.agent_llm.api_key = body.agent.api_key
                if (!cfg.admin) cfg.admin = {}
                if (body.agent.keyword !== undefined) cfg.admin.agent_keyword = body.agent.keyword
                if (body.agent.tools !== undefined) cfg.admin.agent_tools = Array.isArray(body.agent.tools) ? body.agent.tools : String(body.agent.tools).split(",").map(s => s.trim()).filter(Boolean)
            }
            if (body.agent_backend !== undefined) {
                if (!cfg.admin) cfg.admin = {}
                cfg.admin.agent_backend = body.agent_backend
            }
            fs.writeFileSync(path.resolve(__dirname, "../config/settings.json"), JSON.stringify(cfg, null, 2))
            delete require.cache[require.resolve("../config/settings.json")]

            // Clear OpenClaw sessions if backend is OpenClaw and tools changed
            if (cfg.admin?.agent_backend === "openclaw") {
                const { clearOpenClawSessions } = require("../gateway/adminAgent")
                clearOpenClawSessions().catch(err => console.error("Failed to clear OpenClaw sessions:", err))
            }

            sendJson(res, 200, { ok: true })
        } catch (err) {
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/admin/run") {
        try {
            const { task, mode, workspaceId, role } = await readBody(req)
            if (!task) {
                sendJson(res, 400, { error: "task required" })
                return
            }
            const payload = mode === "query" ? task : `agent ${task}`
            const resolvedWorkspace = workspaceId || getActiveWorkspace()
            const response = await handleAdmin(payload, { workspaceId: resolvedWorkspace, role, phone: `http-admin:${resolvedWorkspace}:${role || "super_admin"}` })
            sendJson(res, 200, { ok: true, response, mode: mode || "agent", workspaceId: resolvedWorkspace })
        } catch (err) {
            logger.error({ err }, "setup admin run failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/agent-chat/run") {
        try {
            const { task, workspaceId, role } = await readBody(req)
            if (!task) {
                sendJson(res, 400, { error: "task required" })
                return
            }
            const resolvedWorkspace = workspaceId || getActiveWorkspace()
            const response = await handleAdmin(task, {
                flow: "agent",
                workspaceId: resolvedWorkspace,
                role,
                phone: `http-agent:${resolvedWorkspace}:${role || "super_admin"}`,
            })
            sendJson(res, 200, { ok: true, response, mode: "agent", workspaceId: resolvedWorkspace })
        } catch (err) {
            logger.error({ err }, "setup agent chat run failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "GET" && pathname === "/setup/agent-chat/meta") {
        try {
            const workspaceId = getWorkspaceFromReq(req)
            sendJson(res, 200, {
                ok: true,
                workspaceId,
                approvalsList: listApprovals("", workspaceId),
                ...getOpenClawSummary(),
            })
        } catch (err) {
            logger.error({ err }, "setup agent chat meta failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "GET" && pathname === "/setup/agent-chat/history") {
        try {
            const sessionKey = url.searchParams.get("sessionKey") || "agent:agent:main"
            const history = readOpenClawSessionHistory("agent", sessionKey)
            sendJson(res, 200, { ok: true, history })
        } catch (err) {
            logger.error({ err }, "setup agent chat history failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/agent-chat/reset") {
        try {
            await clearOpenClawSessions()
            sendJson(res, 200, { ok: true })
        } catch (err) {
            logger.error({ err }, "setup agent chat reset failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/admin/image") {
        try {
            const { image, caption, workspaceId } = await readBody(req)
            if (!image) {
                sendJson(res, 400, { error: "image (base64) required" })
                return
            }
            const response = await handleAdminImage(image, caption, { workspaceId: workspaceId || getActiveWorkspace() })
            sendJson(res, 200, { ok: true, response })
        } catch (err) {
            logger.error({ err }, "setup admin image failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "GET" && pathname === "/setup/workspaces") {
        try {
            sendJson(res, 200, { workspaces: listWorkspaceIds(), active: getActiveWorkspace() })
        } catch (err) {
            logger.error({ err }, "setup workspaces list failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "GET" && pathname === "/setup/workers") {
        try {
            sendJson(res, 200, { workers: listWorkers() })
        } catch (err) {
            logger.error({ err }, "setup workers list failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    // GET /agent/intents
    if (req.method === "GET" && pathname === "/agent/intents") {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            sendJson(res, 200, { intents: agentChain.getIntents() })
        } catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    // GET /setup/llm/config
    if (req.method === "GET" && pathname === "/setup/llm/config") {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            const settingsPath = path.resolve(__dirname, "../config/settings.json")
            const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
            sendJson(res, 200, {
                customer: cfg.customer?.llm || {},
                admin: cfg.admin?.llm || {},
                agent: cfg.agent?.llm || {},
                agent_backend: cfg.agent?.backend || "local"
            })
        } catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    // PUT /setup/llm/config
    if (req.method === "PUT" && pathname === "/setup/llm/config") {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            const body = await readBody(req)
            const settingsPath = path.resolve(__dirname, "../config/settings.json")
            const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"))

            if (body.customer) cfg.customer = { ...cfg.customer, llm: body.customer }
            if (body.admin)    cfg.admin    = { ...cfg.admin,    llm: body.admin }
            if (body.agent)    cfg.agent    = { ...cfg.agent,    llm: body.agent }
            if (body.agent_backend) {
                if (!cfg.agent) cfg.agent = {}
                cfg.agent.backend = body.agent_backend
            }

            fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2), "utf8")
            
            // clear sessions as required by issue description
            cartStore.clearAll()
            await clearOpenClawSessions().catch(() => {})

            sendJson(res, 200, { ok: true })
        } catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    // GET /agent/manifest
    if (req.method === "GET" && pathname === "/agent/manifest") {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            const manifestPath = agentChain.getManifestPath()
            const content = fs.readFileSync(manifestPath, "utf8")
            sendJson(res, 200, { path: manifestPath, content })
        } catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    // POST /agent/manifest
    if (req.method === "POST" && pathname === "/agent/manifest") {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            const { content } = await readBody(req)
            if (!content) { sendJson(res, 400, { error: "content required" }); return }
            
            const manifestPath = agentChain.getManifestPath()
            // validate yaml
            yaml.load(content)
            fs.writeFileSync(manifestPath, content, "utf8")
            agentChain.reloadAgent()
            
            // clear sessions as required by issue description
            cartStore.clearAll()
            await clearOpenClawSessions().catch(() => {})

            sendJson(res, 200, { ok: true })
        } catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    // GET /agent-config - Unified LLM/Backend management (new endpoint as requested)
    if (req.method === "GET" && pathname === "/agent-config") {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            const settingsPath = path.resolve(__dirname, "../config/settings.json")
            const cfg = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
            
            let availableTools = []
            try {
                availableTools = (agentChain.getTools() || []).map(t => t.name).filter(Boolean)
            } catch {
                availableTools = []
            }
            
            // Build the default configuration from existing top-level settings if flows doesn't exist
            const defaultFlows = {
                customer: { 
                    llm: cfg.customer?.llm || {}, 
                    backend: cfg.customer?.backend || "direct",
                    execution: normalizeCustomerExecutionConfig(cfg.flows?.customer?.execution || {}),
                    auth: cfg.flows?.customer?.auth || {}
                },
                admin: { 
                    llm: cfg.admin?.llm || {}, 
                    backend: cfg.flows?.admin?.backend || cfg.admin?.backend || "direct", 
                    tools: cfg.admin?.tools || [],
                    auth: {
                        keyword: cfg.admin?.keyword || "admin",
                        pin: cfg.admin?.pin || "",
                        allowed_numbers: (cfg.flows?.admin?.auth?.allowed_numbers || (cfg.admin?.users || []).map(u => u.phone).filter(Boolean) || (cfg.admin?.number ? [cfg.admin.number] : [])),
                    }
                },
                agent: { 
                    llm: cfg.agent?.llm || cfg.admin?.agent_llm || {}, 
                    backend: cfg.admin?.agent_backend || "openclaw", 
                    tools: cfg.admin?.agent_tools || [],
                    auth: {
                        keyword: cfg.admin?.agent_keyword || "agent",
                        pin: cfg.flows?.agent?.auth?.pin || cfg.admin?.pin || "",
                        allowed_numbers: (cfg.flows?.agent?.auth?.allowed_numbers || (cfg.admin?.users || []).map(u => u.phone).filter(Boolean) || (cfg.admin?.number ? [cfg.admin.number] : [])),
                    }
                }
            }

            const configuredFlows = cfg.flows || {}
            const mergeFlow = (base, override) => {
                const merged = { ...(base || {}) }
                if (override && typeof override === "object") {
                    for (const [k, v] of Object.entries(override)) {
                        if (k === "llm") continue
                        merged[k] = v
                    }
                }
                if (base?.llm || override?.llm) {
                    merged.llm = { ...(base?.llm || {}), ...(override?.llm || {}) }
                }
                if (base?.execution || override?.execution) {
                    merged.execution = { ...(base?.execution || {}), ...(override?.execution || {}) }
                }
                if (override && Object.prototype.hasOwnProperty.call(override, "tools")) {
                    merged.tools = override.tools
                } else if (base && Object.prototype.hasOwnProperty.call(base, "tools")) {
                    merged.tools = base.tools
                }
                return merged
            }

            const resultFlows = {
                customer: mergeFlow(defaultFlows.customer, configuredFlows.customer),
                admin: mergeFlow(defaultFlows.admin, configuredFlows.admin),
                agent: mergeFlow(defaultFlows.agent, configuredFlows.agent),
            }
            resultFlows.customer.execution = normalizeCustomerExecutionConfig(resultFlows.customer.execution || {})

            sendJson(res, 200, { 
                flows: resultFlows,
                availableTools,
                customerBackendPresets: listCustomerBackendPresets(),
            })
        } catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    if (req.method === "GET" && pathname === "/agent-config/customer-presets") {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        sendJson(res, 200, { presets: listCustomerBackendPresets() })
        return
    }

    if (req.method === "GET" && pathname.startsWith("/agent-config/customer-presets/")) {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        const presetId = pathname.replace("/agent-config/customer-presets/", "")
        const preset = getCustomerBackendPreset(presetId)
        if (!preset) { sendJson(res, 404, { error: "preset_not_found" }); return }
        sendJson(res, 200, { preset })
        return
    }

    // POST /agent-config - Unified LLM/Backend management
    if (req.method === "POST" && pathname === "/agent-config") {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            const body = await readBody(req)
            const settingsPath = path.resolve(__dirname, "../config/settings.json")
            const current = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
            
            if (body.flows) {
                if (!current.flows) current.flows = {}
                for (const [flowName, flowCfg] of Object.entries(body.flows)) {
                    const existing = current.flows[flowName] || {}
                    const merged = { ...existing, ...flowCfg }
                    if (existing.llm || flowCfg.llm) {
                        merged.llm = { ...(existing.llm || {}), ...(flowCfg.llm || {}) }
                    }
                    if (existing.execution || flowCfg.execution) {
                        merged.execution = { ...(existing.execution || {}), ...(flowCfg.execution || {}) }
                    }
                    if (flowCfg && Object.prototype.hasOwnProperty.call(flowCfg, "tools")) {
                        merged.tools = flowCfg.tools
                    } else if (existing && Object.prototype.hasOwnProperty.call(existing, "tools")) {
                        merged.tools = existing.tools
                    }
                    current.flows[flowName] = merged
                    if (flowName === "customer") {
                        const allowedIntentNames = (() => {
                            try { return agentChain.getIntents().map(intent => intent.name) } catch { return [] }
                        })()
                        const validation = validateCustomerExecutionConfig(merged.execution || {}, allowedIntentNames)
                        if (!validation.ok) {
                            sendJson(res, 400, { error: validation.errors.join("; ") })
                            return
                        }
                        merged.execution = validation.normalized
                        current.flows[flowName].execution = validation.normalized
                    }
                    if (flowName === "customer") {
                        if (!current.customer) current.customer = {}
                        if (merged.llm) current.customer.llm = { ...current.customer.llm, ...merged.llm }
                        if (merged.backend !== undefined) current.customer.backend = merged.backend
                    }
                    if (flowName === "admin") {
                        if (!current.admin) current.admin = {}
                        if (merged.llm) current.admin.llm = { ...current.admin.llm, ...merged.llm }
                        if (merged.backend !== undefined) current.admin.backend = merged.backend
                        if (merged.tools !== undefined) current.admin.tools = merged.tools
                        if (merged.auth) {
                            current.admin.keyword = merged.auth.keyword !== undefined ? merged.auth.keyword : current.admin.keyword
                            current.admin.pin = merged.auth.pin !== undefined ? merged.auth.pin : current.admin.pin
                        }
                    }
                    if (flowName === "agent") {
                        if (!current.agent) current.agent = {}
                        if (merged.llm) current.agent.llm = { ...current.agent.llm, ...merged.llm }
                        if (merged.backend !== undefined) {
                            current.agent.backend = merged.backend
                            if (!current.admin) current.admin = {}
                            current.admin.agent_backend = merged.backend
                        }
                        if (merged.tools !== undefined) {
                            if (!current.admin) current.admin = {}
                            current.admin.agent_tools = merged.tools
                        }
                        if (merged.endpoint !== undefined) current.agent.endpoint = merged.endpoint
                        if (merged.auth) {
                            if (!current.admin) current.admin = {}
                            current.admin.agent_keyword = merged.auth.keyword !== undefined ? merged.auth.keyword : current.admin.agent_keyword
                        }
                    }
                }
            }
            
            fs.writeFileSync(settingsPath, JSON.stringify(current, null, 2), "utf8")
            delete require.cache[require.resolve("../config/settings.json")]
            agentChain.reloadAgent()
            cartStore.clearAll()
            await clearOpenClawSessions().catch(() => {})

            sendJson(res, 200, { ok: true })
        } catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    // GET /agent/config - Unified LLM/Backend management (Redirect to /agent-config)
    if (req.method === "GET" && pathname === "/agent/config") {
        res.writeHead(301, { "Location": "/agent-config" });
        res.end();
        return;
    }

    // POST /agent/config - Unified LLM/Backend management (Redirect to /agent-config)
    if (req.method === "POST" && pathname === "/agent/config") {
        res.writeHead(301, { "Location": "/agent-config" });
        res.end();
        return;
    }

    // GET /agent/models/:provider - List models for a provider
    if (req.method === "GET" && pathname.startsWith("/agent/models/")) {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            const provider = pathname.replace("/agent/models/", "")
            const { listModels, getFlowConfig } = require("../providers/llm")
            
            // Use config from query or current settings for the provider
            const query = new URL(req.url, `http://${req.headers.host}`).searchParams
            const config = {
                api_key: query.get("api_key"),
                base_url: query.get("base_url"),
                endpoint: query.get("base_url"),
                backend: query.get("backend"),
            }
            
            // Fallback to existing config if not provided in query
            if (!config.api_key || !config.base_url) {
                const existing = getFlowConfig("customer") // any flow will do to get provider defaults
                if (existing.provider === provider) {
                    config.api_key = config.api_key || existing.api_key
                    config.base_url = config.base_url || existing.base_url || existing.url
                }
            }

            const models = await listModels(provider, config)
            sendJson(res, 200, { models })
        } catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    // GET /agent/intents/:name
    if (req.method === "GET" && pathname.startsWith("/agent/intents/")) {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            const name = pathname.replace("/agent/intents/", "")
            sendJson(res, 200, agentChain.getIntent(name))
        } catch (err) { sendJson(res, 404, { error: err.message }) }
        return
    }

    // GET /agent/tools
    if (req.method === "GET" && pathname === "/agent/tools") {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            sendJson(res, 200, { tools: agentChain.getTools() })
        } catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    // GET /agent/tools/:name
    if (req.method === "GET" && pathname.startsWith("/agent/tools/")) {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            const name = pathname.replace("/agent/tools/", "")
            sendJson(res, 200, agentChain.getTool(name))
        } catch (err) { sendJson(res, 404, { error: err.message }) }
        return
    }

    // POST /agent/intents  { name, tool, auth_required, hint }
    if (req.method === "POST" && pathname === "/agent/intents") {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            const { name, tool, auth_required = false, hint } = await readBody(req)
            if (!name || !tool) { sendJson(res, 400, { error: "name and tool required" }); return }
            const intents = agentChain.addIntent(name, { tool, auth_required })
            if (hint) agentChain.addIntentHint(name, hint)
            logger.info({ name, tool }, "agent: intent added")
            sendJson(res, 200, { ok: true, intent: name, intents })
        } catch (err) {
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    // DELETE /agent/intents/:name
    if (req.method === "DELETE" && pathname.startsWith("/agent/intents/")) {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            const name = pathname.replace("/agent/intents/", "")
            const intents = agentChain.deleteIntent(name)
            sendJson(res, 200, { ok: true, deleted: name, intents })
        } catch (err) {
            sendJson(res, 400, { error: err.message })
        }
        return
    }

    // POST /agent/tools  { name, type, ...config }
    if (req.method === "POST" && pathname === "/agent/tools") {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            const { name, ...config } = await readBody(req)
            if (!name || !config.type) { sendJson(res, 400, { error: "name and type required" }); return }
            const tools = agentChain.addTool(name, config)
            logger.info({ name, type: config.type }, "agent: tool added")
            sendJson(res, 200, { ok: true, tool: name, tools })
        } catch (err) {
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    // DELETE /agent/tools/:name
    if (req.method === "DELETE" && pathname.startsWith("/agent/tools/")) {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            const name = pathname.replace("/agent/tools/", "")
            const tools = agentChain.deleteTool(name)
            sendJson(res, 200, { ok: true, deleted: name, tools })
        } catch (err) {
            sendJson(res, 400, { error: err.message })
        }
        return
    }

    // GET /health
    if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, agentChain.healthCheck())
        return
    }

    // GET /capabilities
    if (req.method === "GET" && pathname === "/capabilities") {
        sendJson(res, 200, agentChain.getCapabilities())
        return
    }

    if (req.method === "GET" && pathname === "/governance") {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) {
            sendJson(res, 401, { error: "unauthorized" })
            return
        }
        sendJson(res, 200, getGovernanceSnapshot(settings.admin?.role))
        return
    }

    if (req.method === "GET" && pathname === "/governance/approvals") {
        if (!isSetupAuthorized(req) && req.headers["x-secret"] !== SECRET) {
            sendJson(res, 401, { error: "unauthorized" })
            return
        }
        sendJson(res, 200, { approvals: listApprovals() })
        return
    }

    // ── WhatsApp Debug Interceptor ───────────────────────────────────────────

    if (req.method === "GET" && pathname === "/setup/debug/log") {
        const limit = Number(url.searchParams.get("limit")) || 50
        sendJson(res, 200, { ok: true, log: debugInterceptor.getLog(limit) })
        return
    }

    if (req.method === "GET" && pathname === "/setup/customer/observability") {
        const limit = Number(url.searchParams.get("limit")) || 100
        sendJson(res, 200, { ok: true, summary: summarizeCustomerLog(debugInterceptor.getLog(limit)) })
        return
    }

    if (req.method === "GET" && pathname === "/setup/debug/status") {
        sendJson(res, 200, { enabled: debugInterceptor.isEnabled(), held: debugInterceptor.listHeld() })
        return
    }

    if (req.method === "POST" && pathname === "/setup/debug/toggle") {
        try {
            const { enabled } = await readBody(req)
            const result = debugInterceptor.setEnabled(enabled)
            sendJson(res, 200, { ok: true, enabled: result })
        } catch (err) {
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/debug/approve") {
        try {
            const { requestId } = await readBody(req)
            if (!requestId) { sendJson(res, 400, { error: "requestId required" }); return }
            const result = await debugInterceptor.approve(requestId)
            if (result.error) { sendJson(res, 404, result); return }
            sendJson(res, 200, { ok: true, ...result })
        } catch (err) {
            logger.error({ err }, "debug approve failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/debug/reject") {
        try {
            const { requestId, reply } = await readBody(req)
            if (!requestId) { sendJson(res, 400, { error: "requestId required" }); return }
            const result = debugInterceptor.reject(requestId, reply)
            if (!result) { sendJson(res, 404, { error: "not_found" }); return }
            sendJson(res, 200, { ok: true, ...result })
        } catch (err) {
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    // ── Setup-auth proxies for agent CRUD ─────────────────────────────────────

    if (req.method === "GET" && pathname === "/setup/agent/intents") {
        try { sendJson(res, 200, { ok: true, intents: agentChain.getIntents() }) }
        catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    if (req.method === "GET" && pathname === "/setup/agent/tools") {
        try { sendJson(res, 200, { ok: true, tools: agentChain.getTools() }) }
        catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    if (req.method === "POST" && pathname === "/setup/agent/intents") {
        try {
            const { name, tool, auth_required = false, hint } = await readBody(req)
            if (!name || !tool) { sendJson(res, 400, { error: "name and tool required" }); return }
            agentChain.addIntent(name, { tool, auth_required })
            if (hint) agentChain.addIntentHint(name, hint)
            sendJson(res, 200, { ok: true, intents: agentChain.getIntents() })
        } catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    if (req.method === "DELETE" && pathname.startsWith("/setup/agent/intents/")) {
        try {
            const name = decodeURIComponent(pathname.replace("/setup/agent/intents/", ""))
            agentChain.deleteIntent(name)
            sendJson(res, 200, { ok: true, intents: agentChain.getIntents() })
        } catch (err) { sendJson(res, 400, { error: err.message }) }
        return
    }

    if (req.method === "POST" && pathname === "/setup/agent/tools") {
        try {
            const { name, ...config } = await readBody(req)
            if (!name || !config.type) { sendJson(res, 400, { error: "name and type required" }); return }
            agentChain.addTool(name, config)
            sendJson(res, 200, { ok: true, tools: agentChain.getTools() })
        } catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    if (req.method === "DELETE" && pathname.startsWith("/setup/agent/tools/")) {
        try {
            const name = decodeURIComponent(pathname.replace("/setup/agent/tools/", ""))
            agentChain.deleteTool(name)
            sendJson(res, 200, { ok: true, tools: agentChain.getTools() })
        } catch (err) { sendJson(res, 400, { error: err.message }) }
        return
    }

    // ── AI Field Generation ──────────────────────────────────────────────────

    if (req.method === "POST" && pathname === "/setup/ai/generate-field") {
        try {
            const { field, context, workspaceId } = await readBody(req)
            if (!field) { sendJson(res, 400, { error: "field required" }); return }
            const profile = loadProfile(workspaceId || getActiveWorkspace())
            const apiKey = profile.openaiKey || settings.llm?.api_key
            if (!apiKey) { sendJson(res, 400, { error: "No OpenAI API key configured" }); return }
            const { callGpt } = require("../setup/generate")
            const biz = `${profile.businessName || "Business"} (${profile.businessType || "general"}). ${profile.description || ""}`.trim()
            const prompts = {
                description: { s: "You write concise business descriptions for AI agent profiles.", u: `Write a 2-3 sentence business description for: ${profile.businessName} (${profile.businessType}). Tagline: ${profile.brandTagline}. Audience: ${profile.targetAudience}. Offerings: ${profile.offerings}. Return ONLY the description text.` },
                offerings: { s: "You write product/service catalog summaries.", u: `List the main offerings for: ${biz}. Website: ${profile.website}. Return a comma-separated plain text list of products/services.` },
                faqSeed: { s: "You generate FAQ topic lists for customer service agents.", u: `List 10-15 common FAQ topics customers would ask about: ${biz}. Offerings: ${profile.offerings}. Return comma-separated topics only.` },
                supportPolicy: { s: "You write customer support policies.", u: `Write a brief support policy (3-4 sentences) for: ${biz}. Hours: ${profile.businessHours}. Return ONLY the policy text.` },
                escalationPolicy: { s: "You write escalation policies.", u: `Write a brief escalation policy (when to hand off to a human) for: ${biz}. Return ONLY the policy text.` },
                refundPolicy: { s: "You write refund/return policies.", u: `Write a brief refund/return policy for: ${biz}. Fulfillment: ${profile.fulfillmentMode}. Return ONLY the policy text.` },
                launchGoals: { s: "You define launch goals for AI business agents.", u: `Write 2-3 launch goals for an AI WhatsApp agent for: ${biz}. Return ONLY the goals text.` },
                brandVoice: { s: "You define brand voice descriptors.", u: `Suggest a brand voice (3-5 adjectives) for: ${biz}. Audience: ${profile.targetAudience}. Return ONLY comma-separated adjectives.` },
                promptGuide: { s: "You write system prompts for AI business agents.", u: `Write a system prompt for an AI agent handling: ${context || "general customer queries"} for ${biz}. Keep it under 200 words. Return ONLY the prompt text.` },
                intentHint: { s: "You write intent classification hints.", u: `Write a one-sentence hint for classifying the intent "${context || "unknown"}" for: ${biz}. Return ONLY the hint sentence.` },
            }
            const p = prompts[field] || { s: "You are a helpful business assistant.", u: `Generate content for the "${field}" field of a business profile for: ${biz}. ${context || ""}. Return ONLY the content.` }
            const result = await callGpt(apiKey, p.s, p.u)
            sendJson(res, 200, { ok: true, field, result })
        } catch (err) {
            logger.error({ err }, "ai field generation failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    // ── Reload ──────────────────────────────────────────────────────────────────

    if (req.method === "POST" && pathname === "/setup/reload") {
        try {
            agentChain.reloadAgent()
            sendJson(res, 200, { ok: true, agent: agentChain.healthCheck() })
        } catch (err) {
            logger.error({ err }, "setup reload failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    // ── Workflows ─────────────────────────────────────────────────────────────

    if (req.method === "GET" && pathname === "/setup/workflows") {
        sendJson(res, 200, { ok: true, workflows: workflowStore.list() })
        return
    }

    if (req.method === "POST" && pathname === "/setup/workflows/save") {
        try {
            const { name, description, plan } = await readBody(req)
            if (!name || !plan) { sendJson(res, 400, { error: "name and plan required" }); return }
            const workflow = workflowStore.save(name, description, plan, agentChain._manifest)
            sendJson(res, 200, { ok: true, workflow })
        } catch (err) {
            sendJson(res, 400, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/workflows/run") {
        try {
            const { workflowId, phone, inputs } = await readBody(req)
            if (!workflowId) { sendJson(res, 400, { error: "workflowId required" }); return }
            const preview = await buildWorkflowPreview(workflowId, phone || "workflow-runner", getActiveWorkspace(), inputs || {})
            sendJson(res, 200, { ok: true, preview })
        } catch (err) {
            logger.error({ err }, "workflow run failed")
            sendJson(res, err.message === "workflow_not_found" ? 404 : 500, { error: err.message })
        }
        return
    }

    if (req.method === "DELETE" && pathname.startsWith("/setup/workflows/")) {
        try {
            const id = pathname.replace("/setup/workflows/", "")
            const removed = workflowStore.remove(id)
            if (!removed) { sendJson(res, 404, { error: "workflow_not_found" }); return }
            sendJson(res, 200, { ok: true, deleted: id })
        } catch (err) {
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    // ── Preview → Approve → Execute ──────────────────────────────────────────

    if (req.method === "GET" && pathname === "/setup/preview/policy") {
        sendJson(res, 200, { ok: true, policy: getExecutionPolicy() })
        return
    }

    if (req.method === "POST" && pathname === "/setup/preview/policy") {
        try {
            const body = await readBody(req)
            if (body.autoMode !== undefined) setAutoMode(body.autoMode)
            if (body.execution_policy) setExecutionPolicy(body.execution_policy)
            sendJson(res, 200, { ok: true, policy: getExecutionPolicy() })
        } catch (err) {
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/preview") {
        try {
            const { phone, message, workspaceId } = await readBody(req)
            if (!phone || !message) { sendJson(res, 400, { error: "phone and message required" }); return }
            const preview = await buildPreview(message, phone, workspaceId || getActiveWorkspace())
            sendJson(res, 200, { ok: true, preview })
        } catch (err) {
            logger.error({ err }, "setup preview failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/preview/approve") {
        try {
            const { requestId, modifiedPlan } = await readBody(req)
            if (!requestId) { sendJson(res, 400, { error: "requestId required" }); return }
            const result = await approveAndExecute(requestId, modifiedPlan || null)
            if (result.error) { sendJson(res, 404, result); return }
            sendJson(res, 200, { ok: true, ...result })
        } catch (err) {
            logger.error({ err }, "setup preview approve failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/preview/reject") {
        try {
            const { requestId } = await readBody(req)
            if (!requestId) { sendJson(res, 400, { error: "requestId required" }); return }
            const result = rejectPreview(requestId)
            if (!result) { sendJson(res, 404, { error: "preview_not_found" }); return }
            sendJson(res, 200, { ok: true, ...result })
        } catch (err) {
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "GET" && pathname === "/setup/preview/pending") {
        sendJson(res, 200, { ok: true, pending: listPending() })
        return
    }

    if (req.method === "GET" && pathname.startsWith("/setup/preview/") && pathname !== "/setup/preview/pending") {
        const previewId = pathname.replace("/setup/preview/", "")
        const entry = getPending(previewId)
        if (!entry) { sendJson(res, 404, { error: "preview_not_found" }); return }
        sendJson(res, 200, { ok: true, ...entry })
        return
    }

    // POST /message  { phone, message }
    if (req.method === "POST" && pathname === "/message") {
        if (req.headers["x-secret"] !== SECRET) {
            sendJson(res, 401, { error: "unauthorized" })
            return
        }
        try {
            const { phone, message } = await readBody(req)
            if (!phone || !message) {
                sendJson(res, 400, { error: "phone and message required" })
                return
            }
            const response = await agentChain.execute(message, phone)
            sendJson(res, 200, { response })
        } catch (err) {
            logger.error({ err }, "http transport: error")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (res.headersSent) {
        logger.warn({ method: req.method, pathname }, "http transport: headers already sent before 404")
        return
    }
    sendJson(res, 404, { error: "not_found" })
})

function start() {
    server.listen(PORT, "127.0.0.1", () => {
        logger.info({ port: PORT }, "http transport listening")
    })
}

module.exports = { start }
