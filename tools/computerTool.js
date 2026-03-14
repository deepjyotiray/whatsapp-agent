"use strict"

const { chromium } = require("playwright")
const path         = require("path")
const fs           = require("fs")
const { exec }     = require("child_process")

const SCREENSHOT_DIR = path.join(__dirname, "../tmp")
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true })

// Single shared browser + page — reused across tool calls in one agent loop
let _browser = null
let _page    = null

async function getBrowser() {
    if (!_browser || !_browser.isConnected()) {
        _browser = await chromium.launch({ headless: false })  // headless: false so you can see it
        _page    = await _browser.newPage()
    }
    return _page
}

async function closeBrowser() {
    if (_browser) { await _browser.close(); _browser = null; _page = null }
}

// ── Tools ─────────────────────────────────────────────────────────────────────

async function openBrowser(url) {
    const page = await getBrowser()
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 })
    return `✅ Opened: ${page.url()}`
}

async function navigate(url) {
    const page = await getBrowser()
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 })
    return `✅ Navigated to: ${page.url()}`
}

async function screenshot(label = "screenshot") {
    const page = await getBrowser()
    const file = path.join(SCREENSHOT_DIR, `${label}-${Date.now()}.png`)
    await page.screenshot({ path: file, fullPage: false })
    return { text: `📸 Screenshot saved`, imagePath: file }
}

async function click(selector) {
    const page = await getBrowser()
    try {
        await page.click(selector, { timeout: 10000 })
        return `✅ Clicked: ${selector}`
    } catch {
        // fallback: try by text
        await page.getByText(selector).first().click({ timeout: 10000 })
        return `✅ Clicked text: "${selector}"`
    }
}

async function getDom() {
    const page = await getBrowser()
    const url   = page.url()
    const title = await page.title()
    const elements = await page.evaluate((sel) => {
        const results = []
        const nodes = document.querySelectorAll(sel)
        nodes.forEach((el, i) => {
            const rect = el.getBoundingClientRect()
            if (rect.width === 0 && rect.height === 0) return
            results.push({
                index:       i,
                tag:         el.tagName.toLowerCase(),
                type:        el.type || el.getAttribute('role') || '',
                name:        el.name || '',
                id:          el.id || '',
                placeholder: el.placeholder || '',
                text:        (el.innerText || el.value || '').slice(0, 60).trim(),
                ariaLabel:   el.getAttribute('aria-label') || '',
                href:        el.href || ''
            })
        })
        return results
    }, DOM_SELECTOR)
    const lines = elements.map(e =>
        `[${e.index}] <${e.tag}> type=${e.type} name="${e.name}" id="${e.id}" placeholder="${e.placeholder}" aria-label="${e.ariaLabel}" text="${e.text}"${e.href ? ` href="${e.href}"` : ''}`
    )
    return `URL: ${url}\nTitle: ${title}\n\nInteractive elements:\n${lines.join('\n')}\n\nUse type_by_index or click_by_index with the [index] number above.`
}

const DOM_SELECTOR = 'input, textarea, button, a[href], select, [role="button"], [role="textbox"], [contenteditable="true"]'

async function typeByIndex(index, text) {
    const page = await getBrowser()
    const loc = page.locator(DOM_SELECTOR).nth(index)
    await loc.waitFor({ state: 'visible', timeout: 10000 })
    await loc.click({ timeout: 5000 })
    await loc.fill('', { timeout: 5000 })          // clear first
    await loc.pressSequentially(text, { delay: 60 }) // real keystrokes — works with React
    return `✅ Typed into element [${index}]`
}

async function clickByIndex(index) {
    const page = await getBrowser()
    const loc = page.locator(DOM_SELECTOR).nth(index)
    await loc.waitFor({ state: 'visible', timeout: 10000 })
    await loc.click({ timeout: 5000 })
    return `✅ Clicked element [${index}]`
}

async function typeText(selector, text) {
    const page = await getBrowser()
    await page.fill(selector, text, { timeout: 10000 })
    return `✅ Typed into ${selector}`
}

async function pressKey(key) {
    const page = await getBrowser()
    await page.keyboard.press(key)
    return `✅ Pressed: ${key}`
}

async function readPage() {
    const page = await getBrowser()
    const title = await page.title()
    const text  = await page.evaluate(() => document.body.innerText)
    return `📄 Title: ${title}\n\n${text.slice(0, 3000)}`
}

async function scrapePage(selector) {
    const page = await getBrowser()
    if (selector) {
        const els = await page.$$(selector)
        const texts = await Promise.all(els.map(el => el.innerText()))
        return texts.join("\n").slice(0, 3000)
    }
    return await readPage()
}

async function scrollPage(direction = "down") {
    const page = await getBrowser()
    await page.evaluate(dir => {
        window.scrollBy(0, dir === "down" ? window.innerHeight : -window.innerHeight)
    }, direction)
    return `✅ Scrolled ${direction}`
}

async function waitForSelector(selector) {
    const page = await getBrowser()
    await page.waitForSelector(selector, { timeout: 15000 })
    return `✅ Element found: ${selector}`
}

async function getCurrentUrl() {
    const page = await getBrowser()
    return page.url()
}

async function openInChrome(url) {
    return new Promise(resolve => {
        // Open in user's real Chrome (default profile, logged-in accounts)
        const script = `tell application "Google Chrome"
  activate
  if (count of windows) = 0 then make new window
  set URL of active tab of front window to "${url}"
end tell`
        exec(`osascript -e '${script.replace(/'/g, "'\''")}'`, err =>
            resolve(err ? `❌ ${err.message}` : `✅ Opened ${url} in Chrome`)
        )
    })
}

// Execute JS in the real Chrome tab via AppleScript — reads DOM, clicks, etc.
function chromeJs(js) {
    return new Promise(resolve => {
        const escaped = js.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/'/g, "'\\''")
        const script = `tell application "Google Chrome" to execute active tab of front window javascript "${escaped}"`
        exec(`osascript -e '${script}'`, { timeout: 15000 }, (err, stdout) =>
            resolve(err ? `❌ ${err.message}` : (stdout.trim() || '✅ Done'))
        )
    })
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

async function dispatch(name, args) {
    switch (name) {
        case "open_browser":      return await openBrowser(args.url)
        case "navigate":          return await navigate(args.url)
        case "screenshot":        return await screenshot(args.label)
        case "get_dom":          return await getDom()
        case "type_by_index":     return await typeByIndex(args.index, args.text)
        case "click_by_index":    return await clickByIndex(args.index)
        case "click":             return await click(args.selector)
        case "type_text":         return await typeText(args.selector, args.text)
        case "press_key":         return await pressKey(args.key)
        case "read_page":         return await readPage()
        case "scrape_page":       return await scrapePage(args.selector)
        case "scroll":            return await scrollPage(args.direction)
        case "wait_for_element":  return await waitForSelector(args.selector)
        case "get_current_url":   return await getCurrentUrl()
        case "open_in_chrome":    return await openInChrome(args.url)
        case "chrome_js":          return await chromeJs(args.js)
        case "close_browser":     await closeBrowser(); return "✅ Browser closed"
        default:                  return `❌ Unknown computer tool: ${name}`
    }
}

module.exports = { dispatch, closeBrowser }
