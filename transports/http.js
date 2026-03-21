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

const PORT   = settings.transports?.http?.port || 3010
const SECRET = settings.api.secret
const PUBLIC_DIR = path.resolve(__dirname, "../public")
const SETUP_USER = "linkedin"
const SETUP_PASS = "community"
const SETUP_HOSTS = (process.env.SETUP_HOST || "localhost").split(",").map(h => h.trim().toLowerCase())
const SETUP_COOKIE = "secureai_session"
const SESSION_TTL_MS = 1000 * 60 * 60 * 12

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
    try { return String(fs.statSync(path.join(PUBLIC_DIR, "setup", "app.js")).mtimeMs | 0) } catch { return "0" }
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

function createSessionToken() {
    const expiresAt = Date.now() + SESSION_TTL_MS
    const payload = `${SETUP_USER}:${expiresAt}`
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
        return username === SETUP_USER && expiresAt > Date.now()
    } catch {
        return false
    }
}

function clearSession(res) {
    res.setHeader("Set-Cookie", `${SETUP_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`)
}

function setSession(res) {
    const token = createSessionToken()
    res.setHeader("Set-Cookie", `${SETUP_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`)
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
        "/admin": "admin.html",
        "/tools": "tools.html",
        "/intercept": "intercept-v2.html",
        "/control": "control-v2.html",
        "/setup": "dashboard.html",
        "/setup/intercept": "intercept-v2.html",
        "/setup/control": "control-v2.html",
    }

    const isSetupPath = pathname.startsWith("/setup") || setupHost || PAGE_MAP[pathname] || pathname === "/login"
    const loginAsset = req.method === "GET" && (pathname === "/login" || pathname.startsWith("/setup/assets/"))

    if (isSetupPath) {
        if (!loginAsset && !(req.method === "POST" && pathname === "/setup/login") && !isSetupAuthorized(req)) {
            if (req.method === "GET" && PAGE_MAP[pathname]) {
                serveFile(res, path.join(PUBLIC_DIR, "setup", "login.html"))
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

    if (req.method === "GET" && PAGE_MAP[pathname]) {
        serveFile(res, path.join(PUBLIC_DIR, "setup", PAGE_MAP[pathname]))
        return
    }

    if (req.method === "GET" && pathname.startsWith("/setup/assets/")) {
        const rel = pathname.replace("/setup/assets/", "")
        const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "")
        serveFile(res, path.join(PUBLIC_DIR, "setup", safe))
        return
    }

    if (req.method === "POST" && pathname === "/setup/login") {
        try {
            const { username, password } = await readBody(req)
            if (username !== SETUP_USER || password !== SETUP_PASS) {
                clearSession(res)
                sendJson(res, 401, { error: "invalid_credentials" })
                return
            }
            setSession(res)
            sendJson(res, 200, { ok: true })
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

    if (req.method === "POST" && pathname === "/setup/admin/run") {
        try {
            const { task, mode, workspaceId, role } = await readBody(req)
            if (!task) {
                sendJson(res, 400, { error: "task required" })
                return
            }
            const payload = mode === "query" ? task : `agent ${task}`
            const resolvedWorkspace = workspaceId || getActiveWorkspace()
            const response = await handleAdmin(payload, { workspaceId: resolvedWorkspace, role })
            sendJson(res, 200, { ok: true, response, mode: mode || "agent", workspaceId: resolvedWorkspace })
        } catch (err) {
            logger.error({ err }, "setup admin run failed")
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
        if (req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            sendJson(res, 200, { intents: agentChain.getIntents() })
        } catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    // GET /agent/intents/:name
    if (req.method === "GET" && pathname.startsWith("/agent/intents/")) {
        if (req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            const name = pathname.replace("/agent/intents/", "")
            sendJson(res, 200, agentChain.getIntent(name))
        } catch (err) { sendJson(res, 404, { error: err.message }) }
        return
    }

    // GET /agent/tools
    if (req.method === "GET" && pathname === "/agent/tools") {
        if (req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            sendJson(res, 200, { tools: agentChain.getTools() })
        } catch (err) { sendJson(res, 500, { error: err.message }) }
        return
    }

    // GET /agent/tools/:name
    if (req.method === "GET" && pathname.startsWith("/agent/tools/")) {
        if (req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
        try {
            const name = pathname.replace("/agent/tools/", "")
            sendJson(res, 200, agentChain.getTool(name))
        } catch (err) { sendJson(res, 404, { error: err.message }) }
        return
    }

    // POST /agent/intents  { name, tool, auth_required, hint }
    if (req.method === "POST" && pathname === "/agent/intents") {
        if (req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
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
        if (req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
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
        if (req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
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
        if (req.headers["x-secret"] !== SECRET) { sendJson(res, 401, { error: "unauthorized" }); return }
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
        if (req.headers["x-secret"] !== SECRET) {
            sendJson(res, 401, { error: "unauthorized" })
            return
        }
        sendJson(res, 200, getGovernanceSnapshot(settings.admin?.role))
        return
    }

    if (req.method === "GET" && pathname === "/governance/approvals") {
        if (req.headers["x-secret"] !== SECRET) {
            sendJson(res, 401, { error: "unauthorized" })
            return
        }
        sendJson(res, 200, { approvals: listApprovals() })
        return
    }

    // ── WhatsApp Debug Interceptor ───────────────────────────────────────────

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

    sendJson(res, 404, { error: "not_found" })
})

function start() {
    server.listen(PORT, "127.0.0.1", () => {
        logger.info({ port: PORT }, "http transport listening")
    })
}

module.exports = { start }
