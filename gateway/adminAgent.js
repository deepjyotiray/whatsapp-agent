"use strict"

const { exec }     = require("child_process")
const path         = require("path")
const Database     = require("better-sqlite3")
const fetch        = require("node-fetch")
const fs           = require("fs")
const settings     = require("../config/settings.json")
const logger       = require("./logger")
const computerTool = require("../tools/computerTool")

const DB_PATH      = settings.admin.db_path
const AGENT_URL    = `http://127.0.0.1:${settings.api.port}/send`
const AGENT_SECRET = settings.api.secret
const MAX_TURNS    = 20

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
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
            description: "Run a read-only SQL SELECT query on the orders database.",
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
                properties: { url: { type: "string", description: "Base URL to scan e.g. https://healthymealspot.com" } },
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
            name: "click",
            description: "Click an element on the page by CSS selector or visible text.",
            parameters: {
                type: "object",
                properties: { selector: { type: "string", description: "CSS selector or visible text of the element" } },
                required: ["selector"]
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
            name: "get_dom",
            description: "Get all interactive elements on the current page (inputs, buttons, links) with their index, type, name, placeholder, aria-label. ALWAYS call this after navigating to a page before trying to type or click — it tells you the exact index of each element so you can use type_by_index and click_by_index reliably.",
            parameters: { type: "object", properties: {} }
        }
    },
    {
        type: "function",
        function: {
            name: "type_by_index",
            description: "Type text into an input field identified by its DOM index from get_dom. More reliable than type_text with CSS selectors — use this for all form filling.",
            parameters: {
                type: "object",
                properties: {
                    index: { type: "number", description: "Element index from get_dom" },
                    text:  { type: "string", description: "Text to type" }
                },
                required: ["index", "text"]
            }
        }
    },
    {
        type: "function",
        function: {
            name: "click_by_index",
            description: "Click an element identified by its DOM index from get_dom. More reliable than click with CSS selectors.",
            parameters: {
                type: "object",
                properties: {
                    index: { type: "number", description: "Element index from get_dom" }
                },
                required: ["index"]
            }
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
    }
]

// ── Shell allowlist ───────────────────────────────────────────────────────────

const SHELL_PATTERNS = [
    /^pm2\s/i,      /^tail\s/i,     /^cat\s/i,      /^ls\s*/i,
    /^df\s*/i,      /^du\s/i,       /^uptime/i,     /^node\s/i,
    /^npm\s/i,      /^kill\s/i,     /^ping\s/i,     /^free\s*/i,
    /^ps\s/i,       /^curl\s/i,     /^npx\s/i,      /^which\s/i,
    /^mkdir\s/i,    /^cp\s/i,       /^mv\s/i,
    /^osascript\s/i, /^killall\s/i, /^pkill\s/i,    /^open\s/i,
    /^screencapture\s/i, /^say\s/i, /^defaults\s/i, /^launchctl\s/i,
]

function runShell(cmd) {
    return new Promise(resolve => {
        if (!SHELL_PATTERNS.some(p => p.test(cmd.trim()))) {
            resolve(`❌ Command not allowed: ${cmd.split(" ")[0]}`)
            return
        }
        exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
            const out = (stdout || stderr || "").trim()
            resolve(err && !out ? `❌ ${err.message}` : out || "✅ Done (no output)")
        })
    })
}

// ── Tool implementations ──────────────────────────────────────────────────────

function queryDb(sql) {
    if (!/^\s*SELECT\s/i.test(sql)) return "❌ Only SELECT queries are allowed."
    const db = new Database(DB_PATH, { readonly: true })
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

function updateOrder(orderId, deliveryStatus, paymentStatus) {
    const db = new Database(DB_PATH)
    try {
        const sets = [], vals = []
        if (deliveryStatus) { sets.push("delivery_status = ?"); vals.push(deliveryStatus) }
        if (paymentStatus)  { sets.push("payment_status = ?");  vals.push(paymentStatus) }
        if (!sets.length) return "❌ Provide delivery_status or payment_status."
        vals.push(orderId)
        const result = db.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id = ?`).run(...vals)
        return result.changes > 0
            ? `✅ Order ${orderId} updated.${deliveryStatus ? ` Delivery: ${deliveryStatus}.` : ""}${paymentStatus ? ` Payment: ${paymentStatus}.` : ""}`
            : `❌ Order ${orderId} not found.`
    } catch (err) {
        return `❌ DB error: ${err.message}`
    } finally {
        db.close()
    }
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
        const abs = path.resolve(__dirname, "..", filePath)
        fs.mkdirSync(path.dirname(abs), { recursive: true })
        fs.writeFileSync(abs, content, "utf8")
        return `✅ Written: ${abs}`
    } catch (err) {
        return `❌ Write failed: ${err.message}`
    }
}

function readFile(filePath) {
    try {
        const abs = path.resolve(__dirname, "..", filePath)
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
        const abs = path.resolve(__dirname, "..", filePath)
        const cwd = path.resolve(__dirname, "..")
        exec(`node "${abs}"`, { cwd, timeout: 30000 }, (err, stdout, stderr) => {
            const out = (stdout || stderr || "").trim()
            resolve(out || (err ? `❌ ${err.message}` : "✅ Done (no output)"))
        })
    })
}

function listTools() {
    const toolsDir = path.resolve(__dirname, "../tools")
    let scripts = ""
    try { scripts = fs.readdirSync(toolsDir).filter(f => f.endsWith(".js")).join(", ") } catch {}
    return `Tool scripts: ${scripts}\nAdmin agent tools: run_shell, query_db, update_order, send_whatsapp, http_request, load_test, recon, server_health, open_browser, open_in_chrome, navigate, screenshot, click, type_text, press_key, read_page, scrape_page, scroll, wait_for_element, get_current_url, close_browser, write_file, read_file, npm_install, run_node, list_tools`
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
    "open_browser", "open_in_chrome", "chrome_js", "navigate", "screenshot", "click",
    "type_text", "press_key", "read_page", "scrape_page", "scroll",
    "wait_for_element", "get_current_url", "close_browser",
    "get_dom", "type_by_index", "click_by_index"
])

function runMacAutomation(script, type) {
    return new Promise(resolve => {
        const cmd = type === "applescript" ? `osascript -e '${script.replace(/'/g, "'\''")}'` : script
        exec(cmd, { timeout: 15000 }, (err, stdout, stderr) =>
            resolve(err ? `❌ ${stderr || err.message}` : (stdout.trim() || "✅ Done"))
        )
    })
}

async function dispatchTool(name, args) {
    logger.info({ tool: name, args }, "adminAgent: tool call")
    if (COMPUTER_TOOLS.has(name)) return await computerTool.dispatch(name, args)
    switch (name) {
        case "run_shell":     return await runShell(args.command)
        case "mac_automation": return await runMacAutomation(args.script, args.type)
        case "query_db":      return queryDb(args.sql)
        case "update_order":  return updateOrder(args.order_id, args.delivery_status, args.payment_status)
        case "send_whatsapp": return await sendWhatsapp(args.phone, args.message)
        case "http_request":  return await httpRequest(args.url, args.method, args.body)
        case "load_test":     return await loadTest(args.url, args.requests, args.concurrency)
        case "recon":         return await recon(args.url)
        case "server_health": return await serverHealth()
        case "write_file":    return writeFile(args.path, args.content)
        case "read_file":     return readFile(args.path)
        case "npm_install":   return await npmInstall(args.packages)
        case "run_node":      return await runNode(args.path)
        case "list_tools":    return listTools()
        default:              return `❌ Unknown tool: ${name}`
    }
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

async function runAgentLoop(task) {
    const cfg      = settings.admin.agent_llm || {}
    const apiKey   = cfg.api_key
    if (!apiKey) return "❌ No API key configured. Set admin.agent_llm.api_key in settings.json."

    const model        = cfg.model || "gpt-4o"
    const apiUrl       = cfg.url   || "https://api.openai.com/v1/chat/completions"
    const businessName = settings.admin.business_name || "the business"

    let messages = [
        {
            role: "system",
            content: `You are a powerful self-healing admin agent for ${businessName}. Today is ${new Date().toDateString()}.

CORE BEHAVIOUR:
- Always use tools to complete tasks. Never say you cannot do something without trying.
- When a tool or approach fails, diagnose WHY it failed and try a different approach automatically.
- If a capability is missing (e.g. no search tool, blocked by bot detection, missing npm package): write the solution yourself using write_file + npm_install + run_node, then use the result.
- If a website blocks scraping, try a different approach: use http_request with a real browser User-Agent, or write a custom Node.js fetch script, or use a free public API.
- For web search, always use DuckDuckGo (https://html.duckduckgo.com/html/?q=) instead of Google — Google blocks all scrapers. Use write_file + run_node with axios+cheerio to fetch DuckDuckGo and parse <a class="result__a"> tags, OR use open_browser to navigate to https://html.duckduckgo.com/html/?q=your+query then scrape_page with selector 'a.result__a'.
- If you write a script and it errors, read the error, fix the script with write_file, and run_node again.
- Never give up after one failure. Exhaust all approaches before concluding something is impossible.
- Be concise in your final summary — just results, no explanation of what you tried.

SELF-HEALING EXAMPLES:
- Web search → always use DuckDuckGo https://html.duckduckgo.com/html/?q=your+query, parse <a class="result__a"> tags with cheerio
- npm package missing → call npm_install then retry
- Script errors → read_file the script, fix it, write_file it back, run_node again
- API needs a key you don't have → use an alternative free API or scrape a different source

BROWSER AUTOMATION RULES — ALWAYS FOLLOW:
1. After open_browser or navigate, ALWAYS call get_dom before interacting.
2. get_dom returns a numbered list of every input/button/link on the page.
3. Use type_by_index and click_by_index with those numbers — NEVER guess CSS selectors.
4. If get_dom shows no elements, call screenshot to see what's on screen, then wait and retry get_dom.
5. For login flows: open_browser → get_dom → type_by_index username → type_by_index password → click_by_index submit → screenshot to verify → close_browser → return summary.
6. Once you have taken a screenshot and completed the task, call close_browser and return your final answer immediately. Do NOT keep clicking or exploring after the task is done.
7. For tasks in the user's Chrome (YouTube, Gmail, Spotify web): use open_in_chrome to navigate, then chrome_js to read DOM/click/play. NEVER use open_browser for these — it opens a separate Playwright window with no login session.
8. For YouTube playback: open_in_chrome with the search URL → wait 2s (run_shell sleep 2) → chrome_js to find and click the first playlist link → chrome_js to click the play button.

AVAILABLE TOOLS: run_shell, mac_automation, query_db, update_order, send_whatsapp, http_request, load_test, recon, server_health, open_browser, open_in_chrome, chrome_js, navigate, screenshot, click, type_text, press_key, read_page, scrape_page, scroll, wait_for_element, get_current_url, close_browser, get_dom, type_by_index, click_by_index, write_file, read_file, npm_install, run_node, list_tools`
        },
        { role: "user", content: task }
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

        const res  = await fetch(apiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify({ model, messages, tools: TOOL_DEFINITIONS })
        })
        const data = await res.json()

        if (!res.ok) {
            logger.error({ status: res.status, body: JSON.stringify(data).slice(0,500), sentMessages: messages.map(m => ({ role: m.role, tool_calls: m.tool_calls?.map(t=>t.id), tool_call_id: m.tool_call_id })) }, "adminAgent: LLM error")
            await computerTool.closeBrowser().catch(() => {})
            return `❌ LLM error: ${data.error?.message || res.status}`
        }

        const message = data.choices?.[0]?.message ?? data.message
        if (!message) {
            await computerTool.closeBrowser().catch(() => {})
            return `❌ No message in response: ${JSON.stringify(data).slice(0, 200)}`
        }
        messages.push(message)

        if (!message.tool_calls?.length) {
            await computerTool.closeBrowser().catch(() => {})
            return (message.content || "").trim() || "✅ Done."
        }

        const toolResults = []
        const visionMessages = []
        for (const tc of message.tool_calls) {
            const args = typeof tc.function.arguments === "string"
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments
            const result = await dispatchTool(tc.function.name, args)

            if (tc.function.name === "screenshot" && result?.imagePath) {
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
    return "⚠️ Agent reached max steps without completing the task."
}

module.exports = { runAgentLoop }
