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
const { getGovernanceSnapshot } = require("../gateway/adminGovernance")
const { listApprovals, approveRequest } = require("../gateway/adminApprovals")
const { handleAdmin } = require("../gateway/admin")
const { getActiveWorkspace } = require("../core/workspace")

const PORT   = settings.transports?.http?.port || 3010
const SECRET = settings.api.secret
const PUBLIC_DIR = path.resolve(__dirname, "../public")
const SETUP_USER = "linkedin"
const SETUP_PASS = "community"
const SETUP_HOST = "secureai.healthymealspot.com"
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

function serveFile(res, filePath) {
    if (!fs.existsSync(filePath)) {
        sendJson(res, 404, { error: "not_found" })
        return
    }
    res.setHeader("Content-Type", contentType(filePath))
    res.writeHead(200).end(fs.readFileSync(filePath))
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
    const setupHost = host === SETUP_HOST
    const loginAsset = req.method === "GET" && (pathname === "/" || pathname === "/login" || pathname.startsWith("/setup/assets/"))
    const loginApi = req.method === "POST" && pathname === "/setup/login"

    if (pathname.startsWith("/setup") || setupHost) {
        if (!loginAsset && !loginApi && !isSetupAuthorized(req)) {
            unauthorizedSetup(res)
            return
        }
    }

    if (req.method === "GET" && pathname === "/" && setupHost) {
        const target = isSetupAuthorized(req) ? "index.html" : "login.html"
        serveFile(res, path.join(PUBLIC_DIR, "setup", target))
        return
    }

    if (req.method === "GET" && pathname === "/login" && setupHost) {
        serveFile(res, path.join(PUBLIC_DIR, "setup", "login.html"))
        return
    }

    if (req.method === "GET" && pathname === "/setup") {
        serveFile(res, path.join(PUBLIC_DIR, "setup", "index.html"))
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
        const workspaceId = getWorkspaceFromReq(req)
        sendJson(res, 200, {
            profile: loadProfile(workspaceId),
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

    if (req.method === "POST" && pathname === "/setup/workspace/select") {
        try {
            const { workspaceId } = await readBody(req)
            if (!workspaceId) {
                sendJson(res, 400, { error: "workspace id required" })
                return
            }
            const activeWorkspace = setActiveWorkspace(workspaceId)
            sendJson(res, 200, { ok: true, activeWorkspace, ...getWorkspaceSummary() })
        } catch (err) {
            logger.error({ err }, "setup workspace select failed")
            sendJson(res, 500, { error: err.message })
        }
        return
    }

    if (req.method === "POST" && pathname === "/setup/chat") {
        try {
            const { phone, message, workspaceId } = await readBody(req)
            if (!phone || !message) {
                sendJson(res, 400, { error: "phone and message required" })
                return
            }
            const profile = loadProfile(workspaceId || getActiveWorkspace())
            const preview = await chatWithDraft(profile, message, phone)
            const response = preview ?? await agentChain.execute(message, phone)
            sendJson(res, 200, { ok: true, response, source: preview ? "draft" : "live" })
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

    if (req.method === "POST" && pathname === "/setup/admin/run") {
        try {
            const { task, mode, workspaceId } = await readBody(req)
            if (!task) {
                sendJson(res, 400, { error: "task required" })
                return
            }
            const payload = mode === "query" ? task : `agent ${task}`
            const resolvedWorkspace = workspaceId || getActiveWorkspace()
            const response = await handleAdmin(payload, { workspaceId: resolvedWorkspace })
            sendJson(res, 200, { ok: true, response, mode: mode || "agent", workspaceId: resolvedWorkspace })
        } catch (err) {
            logger.error({ err }, "setup admin run failed")
            sendJson(res, 500, { error: err.message })
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
