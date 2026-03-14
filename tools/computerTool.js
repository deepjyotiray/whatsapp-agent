"use strict"

const { exec }  = require("child_process")
const path      = require("path")
const fs        = require("fs")

const SCREENSHOT_DIR = path.join(__dirname, "../tmp")
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })

const SESSION = "whatsapp-agent"

// Run a playwright-cli command in the persistent session
function pw(args, timeout = 30000) {
    return new Promise(resolve => {
        const cmd = `npx --yes --package @playwright/cli playwright-cli --session ${SESSION} ${args}`
        exec(cmd, { timeout }, (err, stdout, stderr) => {
            const out = (stdout || "").trim()
            const errMsg = (stderr || "").trim()
            if (err) resolve(`❌ ${errMsg || err.message}`)
            else resolve(out || "✅ Done")
        })
    })
}

// ── Tools ─────────────────────────────────────────────────────────────────────

async function openBrowser(url) {
    return await pw(`open "${url}"`, 30000)
}

async function navigate(url) {
    return await pw(`goto "${url}"`, 30000)
}

async function snapshot() {
    const result = await pw(`snapshot`, 15000)
    const fileMatch = result.match(/\[Snapshot\]\((.+?\.yml)\)/)
    if (fileMatch) {
        const snapFile = path.join(__dirname, "..", ".playwright-cli", path.basename(fileMatch[1]))
        try {
            const content = fs.readFileSync(snapFile, "utf8")
            const lines = content.split("\n").filter(l => /ref=/.test(l))
            // Prefer lines with durations (video links) first, then all refs up to 150
            const videoLines = lines.filter(l => /minute|second|hour/.test(l))
            const otherLines = lines.filter(l => !/minute|second|hour/.test(l))
            const combined = [...videoLines.slice(0, 30), ...otherLines.slice(0, 120)]
            return combined.join("\n") || result
        } catch { return result }
    }
    return result
}

async function screenshot(label = "screenshot") {
    const safe = label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50)
    const file = path.join(SCREENSHOT_DIR, `${safe}-${Date.now()}.png`)
    const result = await pw(`screenshot "${file}"`, 15000)
    if (result.startsWith("❌")) return result
    return { text: `📸 Screenshot saved`, imagePath: file }
}

async function clickRef(ref) {
    const result = await pw(`click "${ref}"`, 10000)
    // Extract new page URL from result if navigation happened
    const urlMatch = result.match(/Page URL: (https?:\/\/[^\s\n]+)/)
    if (urlMatch) return `✅ Clicked. New page URL: ${urlMatch[1]}\n${result}`
    return result
}

async function fillRef(ref, text) {
    return await pw(`fill "${ref}" "${text.replace(/"/g, '\\"')}"`, 10000)
}

async function typeText(text) {
    return await pw(`type "${text.replace(/"/g, '\\"')}"`, 10000)
}

async function runCode(code) {
    // Run arbitrary Playwright JS — page is available as first arg
    const escaped = code.replace(/"/g, '\\"').replace(/\n/g, " ")
    return await pw(`run-code "${escaped}"`, 15000)
}

async function getCurrentUrl() {
    // snapshot output contains "Page URL: ..." — extract it
    const result = await pw(`snapshot`, 10000)
    const urlMatch = result.match(/Page URL: (https?:\/\/[^\s\n]+)/)
    return urlMatch ? urlMatch[1] : result
}

async function closeBrowser() {
    await pw(`close`, 5000).catch(() => {})
    return "✅ Browser closed"
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function dispatch(name, args) {
    switch (name) {
        case "open_browser":     return await openBrowser(args.url)
        case "navigate":         return await navigate(args.url)
        case "snapshot":         return await snapshot()
        case "screenshot":       return await screenshot(args.label)
        case "click":            return await clickRef(args.ref)
        case "fill":             return await fillRef(args.ref, args.text)
        case "type_text":        return await typeText(args.text)
        case "run_code":         return await runCode(args.code)
        case "get_current_url":  return await getCurrentUrl()
        case "open_in_chrome":   return await openBrowser(args.url)  // same session
        case "close_browser":    return await closeBrowser()
        // Legacy aliases kept for backward compat
        case "get_dom":          return await snapshot()
        case "type_by_index":    return `Use snapshot to get refs, then fill the ref`
        case "click_by_index":   return `Use snapshot to get refs, then click the ref`
        case "chrome_js":        return await runCode(args.js || args.code)
        default:                 return `❌ Unknown computer tool: ${name}`
    }
}

module.exports = { dispatch, closeBrowser }
