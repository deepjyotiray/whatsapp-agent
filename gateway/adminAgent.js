"use strict"

const { exec }     = require("child_process")
const path         = require("path")
const Database     = require("better-sqlite3")
const fetch        = require("node-fetch")
const fs           = require("fs")
const settings     = require("../config/settings.json")
const logger       = require("./logger")
const computerTool = require("../tools/computerTool")
const { buildAdminPlan } = require("./adminPlanner")
const { authorizeToolCall, getGovernanceSnapshot } = require("./adminGovernance")
const { createApprovalRequest } = require("./adminApprovals")
const { getActiveWorkspace } = require("../core/workspace")
const { loadProfile } = require("../setup/profileService")
const { loadNotes } = require("../core/dataModelNotes")
const { getPackForWorkspace } = require("../core/domainPacks")
function getLlm() { return require("../providers/llm") }
const { prepareRequest } = require("../runtime/contextPipeline")
const {
    createTaskState,
    appendToolCall,
    setPlan,
    addNote,
    setFinalAnswer,
} = require("./adminTaskState")
const { getWorker, listWorkers } = require("./adminWorkers")
const { registerGuide } = require("../core/promptGuides")

const DB_PATH      = settings.admin.db_path
const AGENT_URL    = `http://127.0.0.1:${settings.api.port}/send`
const AGENT_SECRET = settings.api.secret
const MAX_TURNS    = 20
const ROOT_DIR     = path.resolve(__dirname, "..")
const ADMIN_AUDIT_LOG = path.join(ROOT_DIR, "logs", "admin-agent.audit.log")

function resolveWorkspaceDbPath(workspaceId) {
    const workspaceProfile = loadProfile(workspaceId)
    return workspaceProfile.dbPath || settings.admin.db_path
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const CORE_TOOL_DEFINITIONS = [
    {
        type: "function",
        function: {
            name: "run_shell",
            description: "Run an allowlisted shell command on the server. Use for pm2, logs, disk, uptime, process management.",
            parameters: {
                type: "object",
                properties: { command: { type: "string", description: "The shell command to run" } },
                required: ["command"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "mac_automation",
            description: "Run AppleScript or shell commands to control the Mac: quit/open apps, set volume, show notifications, get battery, control Spotify/Music, move windows, take screenshots, type text into any app, click UI elements. Examples: quit Chrome, open Finder, set volume to 50, show notification, get frontmost app.",
            parameters: {
                type: "object",
                properties: {
                    script: { type: "string", description: "AppleScript to run via osascript -e, OR a shell command like killall/open/screencapture" },
                    type:   { type: "string", enum: ["applescript", "shell"], description: "applescript runs via osascript -e, shell runs directly" }
                },
                required: ["script", "type"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "query_db",
            description: "Run a read-only SQL SELECT query on the database.",
            parameters: {
                type: "object",
                properties: { sql: { type: "string", description: "A SELECT SQL query" } },
                required: ["sql"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "send_whatsapp",
            description: "Send a WhatsApp message to a phone number.",
            parameters: {
                type: "object",
                properties: {
                    phone:   { type: "string", description: "Phone number in international format e.g. +919XXXXXXXXX" },
                    message: { type: "string", description: "Message text to send" }
                },
                required: ["phone", "message"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "http_request",
            description: "Make an HTTP GET or POST request to any URL. Use for checking website status, response time, API testing.",
            parameters: {
                type: "object",
                properties: {
                    url:    { type: "string", description: "The URL to request" },
                    method: { type: "string", description: "GET or POST", enum: ["GET", "POST"] },
                    body:   { type: "string", description: "Request body for POST" }
                },
                required: ["url"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "load_test",
            description: "Stress test a URL by sending multiple HTTP requests and reporting response times, success rate, avg latency.",
            parameters: {
                type: "object",
                properties: {
                    url:         { type: "string", description: "URL to test" },
                    requests:    { type: "number", description: "Total number of requests (default 20)" },
                    concurrency: { type: "number", description: "Parallel requests at a time (default 5)" }
                },
                required: ["url"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "recon",
            description: "Security recon scan on a URL: checks security headers, SSL, server info disclosure, cookie flags, and probes common sensitive paths.",
            parameters: {
                type: "object",
                properties: { url: { type: "string", description: "Base URL to scan e.g. https://example.com" } },
                required: ["url"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "server_health",
            description: "Get current server health: pm2 process list, memory, uptime.",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "open_browser",
            description: "Open a URL in a headless Playwright browser. Use this to start browser automation.",
            parameters: {
                type: "object",
                properties: { url: { type: "string", description: "Full URL to open" } },
                required: ["url"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "open_in_chrome",
            description: "Open a URL in the user's real Chrome browser (default profile, logged-in accounts). Use this for YouTube, Gmail, or any task needing the user's session. Reuses the existing Chrome window — does NOT open a new window.",
            parameters: {
                type: "object",
                properties: { url: { type: "string" } },
                required: ["url"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "chrome_js",
            description: "Execute JavaScript in the active tab of the user's real Chrome browser. Use after open_in_chrome to read the DOM, click elements, get page title, extract links, or trigger playback. Example: document.querySelector('a#video-title').click()",
            parameters: {
                type: "object",
                properties: { js: { type: "string", description: "JavaScript to execute in Chrome's active tab" } },
                required: ["js"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "navigate",
            description: "Navigate the browser to a new URL.",
            parameters: {
                type: "object",
                properties: { url: { type: "string" } },
                required: ["url"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "screenshot",
            description: "Take a screenshot of the current browser page and send it back. Always take a screenshot after navigating to show the result.",
            parameters: {
                type: "object",
                properties: { label: { type: "string", description: "Short label for the filename" } }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "snapshot",
            description: "Get all interactive elements on the current page with their ref IDs. Returns lines like: link \"Title 3 minutes\" [ref=e249]. Use the ref value with click and fill tools.",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "click",
            description: "Click an element by its ref from snapshot. Pass the ref string e.g. e249.",
            parameters: {
                type: "object",
                properties: { ref: { type: "string", description: "Ref string from snapshot e.g. e249" } },
                required: ["ref"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "fill",
            description: "Fill a text input by its ref from snapshot.",
            parameters: {
                type: "object",
                properties: {
                    ref:  { type: "string", description: "Ref string from snapshot" },
                    text: { type: "string", description: "Text to fill" }
                },
                required: ["ref", "text"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "type_text",
            description: "Type text into an input field identified by CSS selector.",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "CSS selector of the input" },
                    text:     { type: "string", description: "Text to type" }
                },
                required: ["selector", "text"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "press_key",
            description: "Press a keyboard key e.g. Enter, Tab, Escape.",
            parameters: {
                type: "object",
                properties: { key: { type: "string" } },
                required: ["key"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "read_page",
            description: "Read the visible text content of the current page. Use to extract information after navigating.",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "scrape_page",
            description: "Scrape text from specific elements on the page using a CSS selector.",
            parameters: {
                type: "object",
                properties: { selector: { type: "string", description: "CSS selector to target specific elements" } }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "scroll",
            description: "Scroll the page up or down.",
            parameters: {
                type: "object",
                properties: { direction: { type: "string", enum: ["up", "down"] } }
            }
        }
    },
    {
        type: "function",
        function: {
            name: "wait_for_element",
            description: "Wait for an element to appear on the page before proceeding.",
            parameters: {
                type: "object",
                properties: { selector: { type: "string" } },
                required: ["selector"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "get_current_url",
            description: "Get the current URL of the browser.",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "close_browser",
            description: "Close the browser when done with all browser tasks.",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "write_file",
            description: "Write content to a file on disk. Use to create new tools, scripts, or config files.",
            parameters: {
                type: "object",
                properties: {
                    path:    { type: "string", description: "Relative path from project root e.g. tmp/search.js" },
                    content: { type: "string", description: "File content to write" }
                },
                required: ["path", "content"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "read_file",
            description: "Read the contents of a file on disk.",
            parameters: {
                type: "object",
                properties: { path: { type: "string", description: "Relative path from project root" } },
                required: ["path"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "npm_install",
            description: "Install one or more npm packages. Use when a required package is missing.",
            parameters: {
                type: "object",
                properties: { packages: { type: "string", description: "Space-separated package names e.g. axios cheerio" } },
                required: ["packages"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "run_node",
            description: "Execute a Node.js script file. Use to run a script you just wrote.",
            parameters: {
                type: "object",
                properties: { path: { type: "string", description: "Relative path to the .js file to run" } },
                required: ["path"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "list_tools",
            description: "List all available built-in tools and custom scripts.",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "list_governance",
            description: "Show governance policy: current admin role, worker-tool topology, and tool risk rules.",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "youtube_play",
            description: "Open a YouTube watch URL in Chrome and start playback. Use this as the final step for all YouTube tasks instead of mac_automation.",
            parameters: {
                type: "object",
                properties: { url: { type: "string", description: "Full youtube.com/watch?v=... URL" } },
                required: ["url"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "run_skill",
            description: "Run a skill from the skills library. Available skills: screenshot, speech, transcribe, imagegen, pdf, slides, sora, playwright, doc, spreadsheet, figma, sentry, yeet, gh-fix-ci, gh-address-comments, netlify-deploy, vercel-deploy, cloudflare-deploy, render-deploy, security-best-practices, security-threat-model, notion-knowledge-capture, notion-meeting-intelligence, linear. Each skill has scripts and instructions for its task.",
            parameters: {
                type: "object",
                properties: {
                    skill:  { type: "string", description: "Skill name e.g. 'speech', 'imagegen', 'screenshot', 'transcribe', 'pdf', 'slides', 'sora'" },
                    task:   { type: "string", description: "What to do with this skill — be specific with file paths, text, options" }
                },
                required: ["skill", "task"]
            }
        }
    }
]

function resolveToolDefinitions(workspaceId) {
    let domainDefs = []
    try {
        const profile = loadProfile(workspaceId)
        const pack = getPackForWorkspace(profile)
        if (pack?.adminToolDefinitions?.length) domainDefs = pack.adminToolDefinitions
    } catch {}
    
    const allTools = [...CORE_TOOL_DEFINITIONS, ...domainDefs]
    const allowlist = settings.admin?.agent_tools
    
    if (Array.isArray(allowlist)) {
        return allTools.filter(t => allowlist.includes(t.function.name))
    }
    
    return allTools
}

// ── Shell allowlist ───────────────────────────────────────────────────────────

const SHELL_PATTERNS = [
    /^pm2\s/i,      /^tail\s/i,     /^cat\s/i,      /^ls\s*/i,
    /^df\s*/i,      /^du\s/i,       /^uptime/i,     /^node\s/i,
    /^npm\s/i,      /^kill\s/i,     /^ping\s/i,     /^free\s*/i,
    /^ps\s/i,       /^curl\s/i,     /^npx\s/i,      /^which\s/i,
    /^mkdir\s/i,    /^cp\s/i,       /^mv\s/i,
    /^osascript\s/i, /^killall\s/i, /^pkill\s/i,    /^open\s/i,
    /^screencapture\s/i, /^say\s/i, /^defaults\s/i, /^launchctl\s/i,
    /^python3\s/i,  /^pip3\s/i,     /^uv\s/i,       /^\.venv\/bin\/python/i,
]

const SHELL_DENY_PATTERNS = [
    /\brm\s+-rf\s+\//i,
    /\bsudo\b/i,
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\bmkfs\b/i,
    /\bdd\s+if=/i,
    /\bchmod\s+-R\s+777\b/i,
    /\bchown\s+-R\b/i,
    />\s*\/dev\/sda/i,
]

const VENV_PYTHON = path.join(__dirname, "../.venv/bin/python3")
const SHELL_ENV = {
    ...process.env,
    OPENAI_API_KEY: settings.admin?.agent_llm?.api_key || process.env.OPENAI_API_KEY || "",
    PATH: `${path.join(__dirname, "../.venv/bin")}:${process.env.PATH || ""}`
}

function audit(event, details = {}) {
    try {
        fs.mkdirSync(path.dirname(ADMIN_AUDIT_LOG), { recursive: true })
        fs.appendFileSync(ADMIN_AUDIT_LOG, JSON.stringify({
            ts: new Date().toISOString(),
            event,
            ...details,
        }) + "\n")
    } catch (err) {
        logger.error({ err }, "adminAgent: audit log failed")
    }
}

function isSafeCommand(cmd) {
    if (!SHELL_PATTERNS.some(p => p.test(cmd.trim()))) return { ok: false, reason: `Command not allowed: ${cmd.split(" ")[0]}` }
    if (SHELL_DENY_PATTERNS.some(p => p.test(cmd))) return { ok: false, reason: "Command blocked by safety policy." }
    return { ok: true }
}

function resolveWorkspacePath(inputPath) {
    const abs = path.resolve(ROOT_DIR, inputPath)
    if (!abs.startsWith(ROOT_DIR + path.sep) && abs !== ROOT_DIR) {
        throw new Error("Path must stay inside the project workspace.")
    }
    return abs
}

function runShell(cmd) {
    return new Promise(resolve => {
        const safety = isSafeCommand(cmd)
        audit("run_shell", { command: cmd, allowed: safety.ok })
        if (!safety.ok) {
            resolve(`❌ ${safety.reason}`)
            return
        }
        exec(cmd, { timeout: 30000, env: SHELL_ENV }, (err, stdout, stderr) => {
            const out = (stdout || stderr || "").trim()
            resolve(err && !out ? `❌ ${err.message}` : out || "✅ Done (no output)")
        })
    })
}

// ── Tool implementations ──────────────────────────────────────────────────────

function queryDb(sql, workspaceId) {
    if (!/^\s*SELECT\s/i.test(sql)) return "❌ Only SELECT queries are allowed."
    const db = new Database(resolveWorkspaceDbPath(workspaceId), { readonly: true })
    try {
        const rows = db.prepare(sql).all()
        if (!rows.length) return "No results."
        const keys  = Object.keys(rows[0])
        const lines = rows.slice(0, 30).map(r => keys.map(k => `${k}: ${r[k]}`).join(" | "))
        return lines.join("\n") + (rows.length > 30 ? `\n... and ${rows.length - 30} more rows` : "")
    } catch (err) {
        return `❌ SQL error: ${err.message}`
    } finally {
        db.close()
    }
}

function dispatchDomainTool(name, args, workspaceId) {
    try {
        const profile = loadProfile(workspaceId)
        const pack = getPackForWorkspace(profile)
        if (pack?.dispatchAdminTool) {
            const result = pack.dispatchAdminTool(name, args, resolveWorkspaceDbPath(workspaceId))
            if (result !== null) return result
        }
    } catch {}
    return null
}

async function sendWhatsapp(phone, message) {
    try {
        const res = await fetch(AGENT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-secret": AGENT_SECRET },
            body: JSON.stringify({ phone, message })
        })
        return res.ok ? `✅ Message sent to ${phone}.` : `❌ Send failed: HTTP ${res.status}`
    } catch (err) {
        return `❌ Send error: ${err.message}`
    }
}

async function httpRequest(url, method = "GET", body) {
    const start = Date.now()
    try {
        const res  = await fetch(url, {
            method,
            headers: { "User-Agent": "whatsapp-agent/2.0" },
            body: method === "POST" ? body : undefined
        })
        const ms   = Date.now() - start
        const text = (await res.text()).slice(0, 500)
        return `${method} ${url}\nStatus: ${res.status} ${res.statusText}\nTime: ${ms}ms\nBody preview: ${text}`
    } catch (err) {
        return `❌ Request failed: ${err.message}`
    }
}

async function loadTest(url, totalRequests = 20, concurrency = 5) {
    const results = []
    const batches = Math.ceil(totalRequests / concurrency)
    for (let b = 0; b < batches; b++) {
        const size  = Math.min(concurrency, totalRequests - b * concurrency)
        const batch = await Promise.all(
            Array.from({ length: size }, async () => {
                const start = Date.now()
                try {
                    const res = await fetch(url, { method: "GET" })
                    return { ok: res.ok, ms: Date.now() - start, status: res.status }
                } catch {
                    return { ok: false, ms: Date.now() - start, status: 0 }
                }
            })
        )
        results.push(...batch)
    }
    const success = results.filter(r => r.ok).length
    const times   = results.map(r => r.ms).sort((a, b) => a - b)
    const avg     = Math.round(times.reduce((s, t) => s + t, 0) / times.length)
    const p95     = times[Math.floor(times.length * 0.95)]
    return `🔥 Load Test: ${url}\nRequests: ${results.length} | Concurrency: ${concurrency}\n✅ Success: ${success} | ❌ Failed: ${results.length - success}\nAvg: ${avg}ms | Min: ${times[0]}ms | Max: ${times[times.length - 1]}ms | P95: ${p95}ms`
}

async function recon(url) {
    const base = url.replace(/\/$/, "")
    const SECURITY_HEADERS = [
        "strict-transport-security", "content-security-policy",
        "x-frame-options", "x-content-type-options",
        "referrer-policy", "permissions-policy"
    ]
    const SENSITIVE_PATHS = [
        "/.env", "/.git/config", "/admin", "/wp-admin", "/phpmyadmin",
        "/api/users", "/api/orders", "/backup.zip", "/config.json",
        "/robots.txt", "/sitemap.xml"
    ]

    const lines = [`🔍 Recon: ${base}`, ""]

    try {
        const res = await fetch(base, { method: "GET", redirect: "manual" })
        lines.push(`📡 Status: ${res.status} ${res.statusText}`)
        lines.push(`🔒 SSL: ${base.startsWith("https") ? "Yes" : "No"}`)

        const missing = SECURITY_HEADERS.filter(h => !res.headers.get(h))
        const present = SECURITY_HEADERS.filter(h =>  res.headers.get(h))
        lines.push(`\n🛡️ Security Headers:`)
        present.forEach(h => lines.push(`  ✅ ${h}`))
        missing.forEach(h => lines.push(`  ❌ MISSING: ${h}`))

        const server  = res.headers.get("server")
        const powered = res.headers.get("x-powered-by")
        if (server)  lines.push(`\n⚠️  Server exposed: ${server}`)
        if (powered) lines.push(`⚠️  X-Powered-By exposed: ${powered}`)

        const rawCookies = res.headers.raw?.()?.["set-cookie"] || []
        if (rawCookies.length) {
            lines.push(`\n🍪 Cookies (${rawCookies.length}):`)
            rawCookies.forEach(c => {
                const flags = []
                if (!c.toLowerCase().includes("httponly")) flags.push("missing HttpOnly")
                if (!c.toLowerCase().includes("secure"))   flags.push("missing Secure")
                if (!c.toLowerCase().includes("samesite")) flags.push("missing SameSite")
                lines.push(`  ${flags.length ? "⚠️ " + flags.join(", ") : "✅ flags ok"}: ${c.split(";")[0]}`)
            })
        }
    } catch (err) {
        lines.push(`❌ Main request failed: ${err.message}`)
    }

    lines.push(`\n📂 Sensitive Path Probe:`)
    const pathResults = await Promise.all(
        SENSITIVE_PATHS.map(async p => {
            try {
                const r = await fetch(`${base}${p}`, { method: "GET", redirect: "manual" })
                return { path: p, status: r.status }
            } catch {
                return { path: p, status: 0 }
            }
        })
    )
    pathResults.forEach(({ path, status }) => {
        if      (status === 200)             lines.push(`  🚨 EXPOSED (200): ${path}`)
        else if (status === 301 || status === 302) lines.push(`  ↪️  Redirect (${status}): ${path}`)
        else if (status === 403)             lines.push(`  🔒 Forbidden (403): ${path}`)
        else if (status === 0)               lines.push(`  ⬜ Unreachable: ${path}`)
    })

    return lines.join("\n")
}

function writeFile(filePath, content) {
    try {
        const abs = resolveWorkspacePath(filePath)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content, "utf8")
        audit("write_file", { path: abs, bytes: Buffer.byteLength(content, "utf8") })
        return `✅ Written: ${abs}`
    } catch (err) {
        return `❌ Write failed: ${err.message}`
    }
}

function readFile(filePath) {
    try {
        const abs = resolveWorkspacePath(filePath)
        audit("read_file", { path: abs })
        return fs.readFileSync(abs, "utf8").slice(0, 4000)
    } catch (err) {
        return `❌ Read failed: ${err.message}`
    }
}

function npmInstall(packages) {
    return new Promise(resolve => {
        const cwd = path.resolve(__dirname, "..")
        exec(`npm install ${packages} --save`, { cwd, timeout: 60000 }, (err, stdout, stderr) => {
            const out = (stdout || stderr || "").trim()
            resolve(err && !out ? `❌ npm install failed: ${err.message}` : `✅ Installed: ${packages}\n${out.slice(0, 300)}`)
        })
    })
}

function runNode(filePath) {
    return new Promise(resolve => {
        let abs
        try {
            abs = resolveWorkspacePath(filePath)
        } catch (err) {
            resolve(`❌ ${err.message}`)
            return
        }
        const cwd = ROOT_DIR
        audit("run_node", { path: abs })
        exec(`node "${abs}"`, { cwd, timeout: 30000 }, (err, stdout, stderr) => {
            const out = (stdout || stderr || "").trim()
            resolve(out || (err ? `❌ ${err.message}` : "✅ Done (no output)"))
        })
    })
}

function listTools(workspaceId) {
    const toolsDir = path.resolve(__dirname, "../tools")
    let scripts = ""
    try { scripts = fs.readdirSync(toolsDir).filter(f => f.endsWith(".js")).join(", ") } catch {}
    const coreNames = CORE_TOOL_DEFINITIONS.map(t => t.function.name).join(", ")
    let domainNames = ""
    try {
        const profile = loadProfile(workspaceId)
        const pack = getPackForWorkspace(profile)
        if (pack?.adminToolDefinitions?.length) domainNames = pack.adminToolDefinitions.map(t => t.function.name).join(", ")
    } catch {}
    return `Tool scripts: ${scripts}\nCore admin tools: ${coreNames}${domainNames ? `\nDomain tools: ${domainNames}` : ""}`
}

function listGovernance(role, workspaceId) {
    const snapshot = getGovernanceSnapshot(role, workspaceId)
    const workers = Object.entries(snapshot.workers || {})
        .map(([name, tools]) => `- ${name}: ${tools.join(", ")}`)
        .join("\n")
    const tools = Object.entries(snapshot.tools || {})
        .map(([name, cfg]) => `- ${name}: category=${cfg.category}, risk=${cfg.risk}, approval=${cfg.approval}, mutating=${cfg.mutating}`)
        .join("\n")
    return [
        `Role: ${snapshot.role}`,
        snapshot.rolePolicy?.description ? `Role description: ${snapshot.rolePolicy.description}` : null,
        snapshot.rolePolicy?.maxRisk ? `Max risk: ${snapshot.rolePolicy.maxRisk}` : null,
        "",
        "Worker topology:",
        workers || "No worker policy configured.",
        "",
        "Tool policy:",
        tools || "No tool policy configured."
    ].filter(Boolean).join("\n")
}

async function serverHealth() {
    const [pm2Out, uptime, mem] = await Promise.all([
        runShell("pm2 jlist"),
        runShell("uptime"),
        runShell("free -h 2>/dev/null || vm_stat"),
    ])
    let pm2Summary = ""
    try {
        const procs = JSON.parse(pm2Out)
        pm2Summary  = procs.map(p =>
            `• ${p.name} (id:${p.pm_id}) — ${p.pm2_env?.status} | cpu:${p.monit?.cpu}% | mem:${Math.round((p.monit?.memory || 0) / 1024 / 1024)}MB | restarts:${p.pm2_env?.restart_time}`
        ).join("\n")
    } catch {
        pm2Summary = pm2Out
    }
    return `🖥️ Server Health\n\nProcesses:\n${pm2Summary}\n\nUptime: ${uptime}\n\nMemory:\n${mem}`
}

// ── Tool dispatcher ───────────────────────────────────────────────────────────

const COMPUTER_TOOLS = new Set([
    "open_browser", "navigate", "screenshot", "click",
    "type_text", "press_key", "read_page", "scrape_page", "scroll",
    "wait_for_element", "get_current_url", "close_browser",
    "get_dom", "type_by_index", "click_by_index", "snapshot", "fill", "run_code"
])

const SKILLS_DIR = path.join(__dirname, "../skills")

async function runSkill(skillName, task) {
    const skillDir = path.join(SKILLS_DIR, skillName)
    if (!fs.existsSync(skillDir)) {
        const available = fs.readdirSync(SKILLS_DIR).join(", ")
        return `❌ Skill '${skillName}' not found. Available: ${available}`
    }
    const skillMd = path.join(skillDir, "SKILL.md")
    const instructions = fs.existsSync(skillMd) ? fs.readFileSync(skillMd, "utf8").slice(0, 3000) : ""
    const scriptsDir  = path.join(skillDir, "scripts")
    const scripts     = fs.existsSync(scriptsDir) ? fs.readdirSync(scriptsDir) : []

    // Copy skill scripts to tmp/skills/<name>/ so they can be run
    const tmpSkillDir = path.join(__dirname, "../tmp/skills", skillName)
    if (!fs.existsSync(tmpSkillDir)) fs.mkdirSync(tmpSkillDir, { recursive: true })
    for (const f of scripts) {
        const src = path.join(scriptsDir, f)
        const dst = path.join(tmpSkillDir, f)
        if (!fs.existsSync(dst)) fs.copyFileSync(src, dst)
    }

    // Build a ready-to-run example command
    const jsScript = fs.readdirSync(tmpSkillDir).find(f => f.endsWith(".js"))
    const pyScript = scripts.find(f => f.endsWith(".py"))
    let scriptHint = ""
    if (jsScript) {
        scriptHint = `\n\nRUN THE SCRIPT EXACTLY LIKE THIS (do NOT write a new script):\n  run_shell: node tmp/skills/${skillName}/${jsScript} --prompt "<your prompt>" --out output/imagegen/<filename>.png\n\nThis uses Pollinations.ai — no API key needed, completely free.`
    } else if (pyScript) {
        scriptHint = `\n\nRUN THE SCRIPT EXACTLY LIKE THIS (do NOT write a new script):\n  run_shell: .venv/bin/python3 tmp/skills/${skillName}/${pyScript} <subcommand> [flags]\n\nThe script reads OPENAI_API_KEY from the environment automatically — it is already set.`
    }

    const allFiles = fs.readdirSync(tmpSkillDir)
    return `✅ Skill '${skillName}' loaded.\nScripts in tmp/skills/${skillName}/: ${allFiles.join(", ") || "none"}${scriptHint}\n\nInstructions:\n${instructions}\n\nTask: ${task}`
}

function runMacAutomation(script, type) {
    return new Promise(resolve => {
        const cmd = type === "applescript" ? `osascript -e '${script.replace(/'/g, "'\''")}'` : script
        exec(cmd, { timeout: 15000 }, (err, stdout, stderr) =>
            resolve(err ? `❌ ${stderr || err.message}` : (stdout.trim() || "✅ Done"))
        )
    })
}

async function youtubePlay(url) {
    await runMacAutomation(`tell application "Google Chrome" to open location "${url}"`, "applescript")
    await new Promise(r => setTimeout(r, 5000))
    await runMacAutomation(`tell application "Google Chrome" to activate`, "applescript")
    await new Promise(r => setTimeout(r, 500))
    await runMacAutomation(`tell application "System Events" to key code 49`, "applescript")
    return `▶️ Playing: ${url}`
}

async function dispatchTool(name, args, governanceContext = {}) {
    logger.info({ tool: name, args }, "adminAgent: tool call")
    const decision = authorizeToolCall({
        tool: name,
        worker: governanceContext.worker,
        role: governanceContext.role,
        task: governanceContext.task,
        workspaceId: governanceContext.workspaceId,
    })
    audit("tool_call", { tool: name, worker: governanceContext.worker, role: governanceContext.role, allowed: decision.allowed, requiresApproval: decision.requiresApproval, workspaceId: governanceContext.workspaceId })
    if (!decision.allowed) {
        if (decision.requiresApproval) {
            const approval = createApprovalRequest({
                taskId: governanceContext.taskId,
                tool: name,
                task: governanceContext.task,
                worker: governanceContext.worker,
                role: governanceContext.role,
                workspaceId: governanceContext.workspaceId,
                reason: decision.reason,
            })
            return `⏸ Approval required for ${name}.\nApproval ID: ${approval.id}\nReason: ${decision.reason}\nApprove with: ${settings.admin.keyword} ${settings.admin.pin} approve ${approval.id}\nThen rerun the task with token ${approval.id}.`
        }
        return `🚫 Governance blocked ${name}: ${decision.reason}${decision.approvalHint ? ` ${decision.approvalHint}` : ""}`
    }
    if (COMPUTER_TOOLS.has(name)) return await computerTool.dispatch(name, args)
    switch (name) {
        case "run_shell":      return await runShell(args.command)
        case "mac_automation":  return await runMacAutomation(args.script, args.type)
        case "open_in_chrome":  return await runMacAutomation(`tell application "Google Chrome" to open location "${args.url}"`, "applescript")
        case "chrome_js":       return await runMacAutomation(`tell application "Google Chrome" to execute front window's active tab javascript "${(args.js||args.code||"").replace(/"/g,"'")}"`, "applescript")
        case "query_db":      return queryDb(args.sql, governanceContext.workspaceId)
        case "send_whatsapp": return await sendWhatsapp(args.phone, args.message)
        case "http_request":  return await httpRequest(args.url, args.method, args.body)
        case "load_test":     return await loadTest(args.url, args.requests, args.concurrency)
        case "recon":         return await recon(args.url)
        case "server_health": return await serverHealth()
        case "write_file":    return writeFile(args.path, args.content)
        case "read_file":     return readFile(args.path)
        case "npm_install":   return await npmInstall(args.packages)
        case "run_node":      return await runNode(args.path)
        case "list_tools":    return listTools(governanceContext.workspaceId)
        case "list_governance": return listGovernance(governanceContext.role, governanceContext.workspaceId)
        case "youtube_play":   return await youtubePlay(args.url)
        case "run_skill":     return await runSkill(args.skill, args.task)
        default: {
            const domainResult = dispatchDomainTool(name, args, governanceContext.workspaceId)
            if (domainResult !== null) return domainResult
            return `❌ Unknown tool: ${name}`
        }
    }
}

function formatPlan(plan) {
    const steps = Array.isArray(plan?.steps) ? plan.steps : []
    return [
        `Plan summary: ${plan?.summary || "No summary"}`,
        ...steps.map((step, idx) => `${idx + 1}. [${step.worker || "operator"}] ${step.goal} | preferred tools: ${(step.preferred_tools || []).join(", ") || "any safe tool"}`)
    ].join("\n")
}

function formatWorkers() {
    return listWorkers().map(worker =>
        `- ${worker.name}: ${worker.description}\n  strengths: ${worker.strengths.join(", ")}\n  instructions: ${worker.instructions.join(" ")}`
    ).join("\n")
}

function formatStepGuidance(plan) {
    const steps = Array.isArray(plan?.steps) ? plan.steps : []
    return steps.map((step, idx) => {
        const worker = getWorker(step.worker)
        return `${idx + 1}. Step ${step.id} led by ${worker.name}: ${step.goal}
Preferred tools: ${(step.preferred_tools || []).join(", ") || "any safe tool"}
Worker guidance: ${worker.instructions.join(" ")}`
    }).join("\n\n")
}

// ── Agentic loop ──────────────────────────────────────────────────────────────

async function sendScreenshotToAdmin(imagePath) {
    const adminPhone = settings.admin.number
    const to = adminPhone.startsWith("+") ? adminPhone : `+${adminPhone}`
    try {
        await fetch(AGENT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-secret": AGENT_SECRET },
            body: JSON.stringify({ phone: to, imagePath, message: "📸" })
        })
    } catch (err) {
        logger.error({ err }, "adminAgent: screenshot send failed")
    }
}

function parseDirectMacTask(task) {
    const text = String(task || "").trim()
    const openMatch = text.match(/^(?:open|launch|start)\s+(.+)$/i)
    if (openMatch) {
        const appName = openMatch[1].trim()
        if (appName) {
            return {
                tool: "mac_automation",
                args: {
                    type: "applescript",
                    script: `tell application "${appName}" to activate`
                },
                summary: `Opening ${appName}.`,
            }
        }
    }

    const quitMatch = text.match(/^(?:quit|close)\s+(.+)$/i)
    if (quitMatch) {
        const appName = quitMatch[1].trim()
        if (appName) {
            return {
                tool: "mac_automation",
                args: {
                    type: "applescript",
                    script: `tell application "${appName}" to quit`
                },
                summary: `Closing ${appName}.`,
            }
        }
    }

    return null
}

async function runAgentLoop(task, options = {}) {
    const directMacTask = parseDirectMacTask(task)
    if (directMacTask) {
        const directResult = await dispatchTool(directMacTask.tool, directMacTask.args, {
            role: settings.admin?.role || "super_admin",
            worker: "operator",
            task,
            taskId: null,
            workspaceId: options.workspaceId || getActiveWorkspace(),
        })
        if (String(directResult).startsWith("❌") || String(directResult).startsWith("🚫")) {
            return String(directResult)
        }
        return `✅ ${directMacTask.summary}`
    }

    const liveSettings = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../config/settings.json"), "utf8"))
    const adminAgentCfg = liveSettings.admin?.agent_llm || {}
    const flowAgentCfg = liveSettings.agent?.llm || {}
    const cfg = {
        provider: flowAgentCfg.provider || adminAgentCfg.provider || "openai",
        model: flowAgentCfg.model || adminAgentCfg.model || "gpt-4o",
        api_key: flowAgentCfg.api_key || adminAgentCfg.api_key || "",
        base_url: flowAgentCfg.base_url || adminAgentCfg.base_url || "",
    }
    const apiKey   = cfg.api_key
    // Allow non-OpenAI if provider is set, but default to OpenAI for safety in this complex agent
    const providerName = cfg.provider || "openai"
    
    if (!apiKey && providerName === "openai") return "❌ No API key configured. Set admin.agent_llm.api_key or agent.llm.api_key in settings.json."

    const model        = cfg.model || "gpt-4o"
    const workspaceId  = options.workspaceId || getActiveWorkspace()
    const workspaceProfile = loadProfile(workspaceId)
    const businessName = workspaceProfile.businessName || settings.admin?.business_name || "the business"
    const adminRole    = settings.admin?.role || "super_admin"
    const taskState    = createTaskState(task, { businessName, model }, workspaceId)
    const plan         = await buildAdminPlan(task, { businessName })
    setPlan(taskState.taskId, plan.steps, workspaceId)

    let messages = [
        {
            role: "system",
            content: `You are a powerful self-healing admin agent for ${businessName}. Today is ${new Date().toDateString()}.
Follow the execution plan unless evidence forces adaptation. Work step by step, verify results.
BEHAVIOUR:
- Always use tools. Diagnose failures and retry.
- For DuckDuckGo search: use http_request or write_file + run_node.
- Browser automation: call snapshot before click/fill. Use ref from snapshot.
- For YouTube: navigate to search -> snapshot -> click video link -> get_current_url -> close_browser -> youtube_play.
- Mention mutations in final answer.
- Tool list: ${CORE_TOOL_DEFINITIONS.map(t => t.function.name).join(", ")}${(() => { try { const p = loadProfile(workspaceId); const pk = getPackForWorkspace(p); return pk?.adminToolDefinitions?.length ? ", " + pk.adminToolDefinitions.map(t => t.function.name).join(", ") : "" } catch { return "" } })()}
${(() => { const notes = loadNotes(workspaceId); return notes ? "NOTES: " + notes : "" })()}`
        },
        {
            role: "system",
            content: `Execution plan: ${plan.summary}
Steps:
${plan.steps.map((s, i) => `${i + 1}. [${s.worker}] ${s.goal} (Tools: ${(s.preferred_tools || []).join(", ")})`).join("\n")}
Admin role: ${adminRole}
CONTEXT:
${await (async () => {
    try {
        const { buildDbContext } = require("./admin")
        return await buildDbContext(workspaceId)
    } catch { return "No extra context available." }
})()}`
        },
        { role: "user", content: options.imageBase64
            ? [
                { type: "text", text: task },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${options.imageBase64}` } }
              ]
            : task
        }
    ]

    let turns = 0
    while (turns < MAX_TURNS) {
        turns++

        // Strip any assistant tool_call messages that have no matching tool response
        const respondedIds = new Set(messages.filter(m => m.role === 'tool').map(m => m.tool_call_id))
        const sanitized = []
        for (const m of messages) {
            if (m.role === 'assistant' && m.tool_calls?.length) {
                const unanswered = m.tool_calls.filter(tc => !respondedIds.has(tc.id))
                if (unanswered.length) continue  // drop this assistant message entirely
            }
            sanitized.push(m)
        }
        messages = sanitized

        let data
        try {
            const tools = resolveToolDefinitions(workspaceId)
            const response = await getLlm().complete(messages, { 
                flow: "agent", 
                llmConfig: cfg, 
                tools, 
                fullResponse: true 
            })
            data = response
        } catch (err) {
            if (err.status === 429) {
                const retryAfterMs = (() => {
                    const errorBody = typeof err.data === 'string' ? JSON.parse(err.data) : (err.data || {})
                    const msg = errorBody.error?.message || ""
                    const match = msg.match(/(\d+)ms/)
                    return match ? parseInt(match[1]) + 200 : 2000
                })()
                logger.warn({ retryAfterMs }, "adminAgent: rate limited, retrying")
                await new Promise(r => setTimeout(r, retryAfterMs))
                turns--
                continue
            }
            logger.error({ err: err.message }, "adminAgent: LLM error")
            await computerTool.closeBrowser().catch(() => {})
            return `❌ LLM error: ${err.message}`
        }

        const message = data.choices?.[0]?.message ?? data.message
        if (!message) {
            await computerTool.closeBrowser().catch(() => {})
            return `❌ No message in response: ${JSON.stringify(data).slice(0, 200)}`
        }
        messages.push(message)

        if (!message.tool_calls?.length) {
            await computerTool.closeBrowser().catch(() => {})
            const finalAnswer = (message.content || "").trim() || "✅ Done."
            setFinalAnswer(taskState.taskId, finalAnswer, workspaceId)
            return finalAnswer
        }

        const toolResults = []
        const visionMessages = []
        for (const tc of message.tool_calls) {
            const args = typeof tc.function.arguments === "string"
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments
            appendToolCall(taskState.taskId, { tool: tc.function.name, args }, workspaceId)
            const currentStep = plan.steps[Math.min(turns - 1, Math.max(plan.steps.length - 1, 0))] || { worker: "operator", id: "ad-hoc" }
            const result = await dispatchTool(tc.function.name, args, {
                role: adminRole,
                worker: currentStep.worker,
                stepId: currentStep.id,
                taskId: taskState.taskId,
                task,
                workspaceId,
            })
            addNote(taskState.taskId, `${tc.function.name}: ${String(result).slice(0, 500)}`, workspaceId)

            if (tc.function.name === "screenshot" && result?.imagePath) {
                if (!fs.existsSync(result.imagePath)) {
                    toolResults.push({ role: "tool", tool_call_id: tc.id, content: "Screenshot failed: file not written" })
                    continue
                }
                await sendScreenshotToAdmin(result.imagePath)
                const imgB64 = fs.readFileSync(result.imagePath).toString("base64")
                toolResults.push({ role: "tool", tool_call_id: tc.id, content: result.text })
                // Collect vision message to push AFTER all tool results
                visionMessages.push({
                    role: "user",
                    content: [
                        { type: "text",      text: "Here is the current screenshot:" },
                        { type: "image_url", image_url: { url: `data:image/png;base64,${imgB64}` } }
                    ]
                })
                continue
            }

            toolResults.push({ role: "tool", tool_call_id: tc.id, content: String(result) })
        }
        // tool results must immediately follow the assistant message, vision after
        messages.push(...toolResults)
        messages.push(...visionMessages)
    }

    await computerTool.closeBrowser().catch(() => {})
    const finalAnswer = "⚠️ Agent reached max steps without completing the task."
    setFinalAnswer(taskState.taskId, finalAnswer, workspaceId)
    return finalAnswer
}

// ── Prompt guide registrations ─────────────────────────────────────────────

registerGuide({
    id: "admin-agent-system",
    name: "Admin agent — system prompt",
    description: "Core behaviour, tool list, browser rules, self-healing, and data model notes sent as the first system message to the admin agent LLM.",
    source: "gateway/adminAgent.js",
    editable: "Data model notes section — via POST /setup/agent/notes",
    render(workspaceId) {
        const profile = loadProfile(workspaceId)
        const biz = profile.businessName || workspaceId
        const notes = loadNotes(workspaceId)
        const notesBlock = notes
            ? "DATA MODEL NOTES (auto-generated for this workspace):\n" + notes
            : "(no data model notes generated yet — call POST /setup/agent/notes/regenerate)"
        const toolNames = CORE_TOOL_DEFINITIONS.map(t => t.function.name).join(", ")
        return `You are a powerful self-healing admin agent for ${biz}. Today is ${new Date().toDateString()}.\n\n...core behaviour, browser rules, self-healing (see source)...\n\nAVAILABLE TOOLS: ${toolNames}\n\n${notesBlock}`
    },
})

registerGuide({
    id: "admin-agent-task",
    name: "Admin agent — task context",
    description: "Second system message with workspace ID, admin role, worker roster, execution plan, and step guidance.",
    source: "gateway/adminAgent.js",
    editable: "Workers via gateway/adminWorkers.js, plan is auto-generated per task",
    render() {
        const role = settings.admin?.role || "super_admin"
        return `Task ID: (generated at runtime)\nAdmin role: ${role}\n\nWorker roster:\n${formatWorkers()}\n\nExecution plan: (generated by planner at runtime)\nDetailed step guidance: (generated by planner at runtime)`
    },
})

// ── OpenClaw Gateway backend ─────────────────────────────────────────────────

function renderMessagesForOpenClaw(messages = []) {
    return messages
        .filter(msg => msg && msg.content != null)
        .map(msg => {
            const role = String(msg.role || "user").toUpperCase()
            const content = Array.isArray(msg.content)
                ? msg.content.map(part => {
                    if (typeof part === "string") return part
                    if (part && typeof part.text === "string") return part.text
                    return JSON.stringify(part)
                }).join("\n")
                : String(msg.content)
            return `${role}:\n${content}`.trim()
        })
        .join("\n\n")
}

async function runOpenClawAgent(task, options = {}) {
    const flow = options.flow || "agent"

    return new Promise(async (resolve) => {
        const executionFlow = options.flow || flow || "agent"
        const openclawAgent = executionFlow === "admin" ? "admin" : "agent"
        const workspaceId = options.workspaceId || getActiveWorkspace()
        const backendConfig = options.backend_config || {}
        const timeout = Number(options.timeout || backendConfig.timeout || 90)
        const cliCommand = String(options.command || backendConfig.command || "openclaw").trim() || "openclaw"
        
        const hasNativeMessages = Array.isArray(options.messages) && options.messages.length > 0

        // Use tools from settings if available, otherwise fallback to CORE_TOOL_DEFINITIONS
        const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../config/settings.json"), "utf8"))
        const allowedToolNames = executionFlow === "agent" ? (cfg.admin?.agent_tools || []) : (cfg.admin?.tools || [])
        
        // Map common tool names to their core implementation names
        const toolMap = { "shell": "run_shell", "db": "query_db", "sql": "query_db" }
        const normalizedAllowed = allowedToolNames.map(n => toolMap[n] || n)
        
        const filteredTools = normalizedAllowed.length > 0
            ? CORE_TOOL_DEFINITIONS.filter(t => normalizedAllowed.includes(t.function.name))
            : CORE_TOOL_DEFINITIONS

        if (!hasNativeMessages) {
            // Inject tool implementations into TOOLS.md for OpenClaw's internal reference
            try {
                const openclawToolsPath = path.resolve(process.env.HOME, `.openclaw/${openclawAgent}_workspace/TOOLS.md`)
                if (fs.existsSync(openclawToolsPath)) {
                    let toolsMd = fs.readFileSync(openclawToolsPath, "utf8")
                    const toolRegistryHeader = "## ACTIVE ADMIN TOOLS (Dynamic)"
                    const registryContent = `\n\n${toolRegistryHeader}\n\n` +
                        filteredTools.map(t => `### ${t.function.name}\n- Description: ${t.function.description}\n- Skill invocation: Use the tool name directly as a command: \`${t.function.name}\`. Example: \`${t.function.name}(${Object.keys(t.function.parameters.properties).map(k => `${k}="..."`).join(", ")})\`.`).join("\n\n")

                    if (toolsMd.includes(toolRegistryHeader)) {
                        toolsMd = toolsMd.split(toolRegistryHeader)[0] + registryContent
                    } else {
                        toolsMd += registryContent
                    }
                    fs.writeFileSync(openclawToolsPath, toolsMd, "utf8")
                }
            } catch (err) {
                logger.warn({ err: err.message }, "OpenClaw: failed to update TOOLS.md")
            }
        }

        let finalTask = task
        const toolsDesc = filteredTools.map(t => `- ${t.function.name}: ${t.function.description}`).join("\n")

        if (hasNativeMessages) {
            finalTask = renderMessagesForOpenClaw(options.messages)
            logger.info({ flow: executionFlow, messages: options.messages.length }, "OpenClaw: using native flow messages")
        } else if (!options.noContext) {
            // Admin flow: provide DB context and schema to OpenClaw
            try {
                const { buildDbContext, getDbSchema, selectRelevantTables } = require("./admin")
                const profile = loadProfile(workspaceId)
                const dbPath = profile.dbPath || settings.admin.db_path
                
                // Optimization: identify relevant tables for the task to reduce token usage
                const relevantTables = await selectRelevantTables(task, workspaceId)
                
                const dbContext = await buildDbContext(workspaceId, relevantTables)
                const schema = getDbSchema(dbPath, relevantTables)
                const notes = loadNotes(workspaceId)
                
                finalTask = `CONTEXT:
${dbContext}

DATABASE SCHEMA:
${schema}
${notes ? `\nDATA MODEL NOTES:\n${notes}` : ""}

AVAILABLE TOOLS:
${toolsDesc}

SYSTEM INSTRUCTIONS:
- You are an admin agent with direct access to the database and server via the tools listed above.
- If a tool is listed under "AVAILABLE TOOLS", you MUST use it directly to fulfill the request.
- Do NOT refuse access or claim you lack tools if they are listed in the AVAILABLE TOOLS block.
- Examples of tool calls:
  - query_db(sql="SELECT * FROM users")
  - run_shell(command="pm2 status")
- If a tool name doesn't work, use it with the 'skill_call' syntax:
  - skill_call(skill="query_db", args={"sql": "SELECT * FROM users"})
- Use 'query_db' for any data retrieval. It is a native tool you can call.
- One customer might have multiple active subscriptions (e.g., for different meal types). Sum them all unless asked otherwise.
- JOIN 'subscriptions' and 'subscription_deliveries' to get the most accurate, live count of delivered meals.
- Use 'LIKE %name%' for customer searches to be robust against name variations.
- If you cannot find a tool, check your 'Skills' or use the command format directly.

ADMIN TASK:
${task}`
                const beforeLen = task.length
                const afterLen = finalTask.length
                logger.info({ beforeLen, afterLen, tables: relevantTables }, "OpenClaw: context built with schema pruning")
            } catch (err) {
                logger.warn({ err: err.message }, "OpenClaw: failed to build context, sending raw task")
            }
        } else {
            // Even if noContext is true (explicit agent call), we must tell OpenClaw what it can do
            finalTask = `AVAILABLE TOOLS:
${toolsDesc}

SYSTEM INSTRUCTIONS:
- You are an admin agent with direct access to the database and server via the tools listed above.
- If a tool is listed under "AVAILABLE TOOLS", you MUST use it directly to fulfill the request.
- Do NOT refuse access or claim you lack tools if they are listed in the AVAILABLE TOOLS block.
- Examples of tool calls:
  - query_db(sql="SELECT * FROM users")
  - run_shell(command="pm2 status")
- If a tool name doesn't work, use it with the 'skill_call' syntax:
  - skill_call(skill="query_db", args={"sql": "SELECT * FROM users"})
- Use 'query_db' for any data retrieval. It is a native tool you can call.

ADMIN TASK:
${task}`
        }

        const args = [
            "agent",
            "--agent", openclawAgent,
            "-m", finalTask,
            "--json",
            "--timeout", String(timeout),
        ]

        if (options.noContext) {
            // args.push("--no-context") // Flag not supported by OpenClaw CLI
            logger.info("Admin: 'noContext' requested, but OpenClaw CLI does not support '--no-context'. Skipping flag.")
        }

        logger.info({ task, backend: "openclaw", flow: executionFlow, cliCommand, noContext: !!options.noContext, nativeMessages: hasNativeMessages }, "openclaw: forwarding")
        const child = exec(`${cliCommand} ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(" ")}`, {
            timeout: (timeout + 10) * 1000,
            env: { ...process.env },
        }, (err, stdout, stderr) => {
            if (err && !stdout) {
                logger.error({ err: err.message, stderr }, "openclaw agent failed")
                resolve(`❌ OpenClaw error: ${err.message}`)
                return
            }
            try {
                const result = JSON.parse(stdout)
                const payloads = result.result?.payloads || []
                
                // If OpenClaw output contains tool calls in its own format, we might need to bridge them
                // but usually it should just return text if it doesn't have a native integration.
                // However, our task description now tells it tools exist. 
                // If OpenClaw tries to call a tool by printing something like 'TOOL: query_db {"sql": "... "}'
                // we would need a wrapper. 
                // BUT, OpenClaw CLI's "agent" mode is a full turn that usually returns a final answer.
                
                const text = payloads.map(p => p.text).filter(Boolean).join("\n")
                const model = result.result?.meta?.agentMeta?.model || "unknown"
                const duration = result.result?.meta?.durationMs || 0
                const reply = text || `⚠️ OpenClaw returned no text (status: ${result.status})`
                logger.info({ model, duration, status: result.status }, "openclaw agent done")
                resolve(reply)
            } catch {
                resolve(stdout.trim() || `❌ OpenClaw: unexpected output`)
            }
        })
    })
}

async function dispatchAgentTask(task, options = {}) {
    const llm = getLlm()
    const resolved = llm && typeof llm.getFlowConfig === "function"
        ? llm.getFlowConfig(options.flow || "agent")
        : {}
    const backend = options.backend || resolved.backend || "local"
    const backendConfig = options.backend_config || resolved.backend_config || {}

    if (backend === "openclaw" || backend === "myclaw" || backend === "nemoclaw") {
        return runOpenClawAgent(task, { ...options, backend, backend_config: backendConfig, endpoint: options.endpoint || resolved.endpoint })
    }
    if (backend && backend !== "direct" && backend !== "local") {
        const BackendAdapter = require("../providers/adapters/backend")
        const adapter = new BackendAdapter({
            ...cfg.agent,
            backend,
            endpoint: options.endpoint || resolved.endpoint || cfg.agent?.endpoint,
            backend_config: backendConfig,
        })
        return await adapter.complete(task, { ...options, _backend_redirect: true })
    }
    return runAgentLoop(task, options)
}

async function clearOpenClawSessions() {
    const agents = ["admin", "agent"]
    for (const agent of agents) {
        await new Promise((resolve) => {
            const sessionsDir = path.resolve(process.env.HOME, `.openclaw/agents/${agent}/sessions`)
            if (!fs.existsSync(sessionsDir)) return resolve()
            
            fs.readdir(sessionsDir, (err, files) => {
                if (err) {
                    logger.error({ agent, err: err.message }, "Admin: failed to list OpenClaw sessions for cleanup")
                    return resolve()
                }
                
                let deleted = 0
                for (const file of files) {
                    if (file.endsWith(".jsonl") || file === "sessions.json") {
                        try {
                            fs.unlinkSync(path.join(sessionsDir, file))
                            deleted++
                        } catch (e) {
                            logger.warn({ agent, file, err: e.message }, "Admin: failed to delete OpenClaw session file")
                        }
                    }
                }
                if (deleted > 0) logger.info({ agent, deleted }, "Admin: cleared OpenClaw sessions due to tool change")
                resolve()
            })
        })
    }
}

module.exports = { runAgentLoop, runOpenClawAgent, dispatchAgentTask, clearOpenClawSessions }
