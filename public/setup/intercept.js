/* global fetch */
"use strict"

const GATE_IDS = ["sanitizer", "session", "heuristic", "llm_intent", "policy", "manifest_guard", "tool_resolution"]
const STATUS_LABELS = { pass: "PASS", fail: "FAIL", override: "OVERRIDE", skipped: "SKIPPED", fallback: "FALLBACK", idle: "—" }

let _selected = null
let _pollTimer = null

function loginUrl() {
    return `/login?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`
}

// ── API ──────────────────────────────────────────────────────────────────────

async function api(url, method = "GET", body) {
    const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 401) { window.location.href = loginUrl(); throw new Error("Unauthorized") }
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    return data
}

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML }

function fmtAge(seconds) {
    if (seconds < 60) return `${seconds}s ago`
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s ago`
}

// ── Toggle ───────────────────────────────────────────────────────────────────

const toggle = document.getElementById("master-toggle")
const toggleLabel = document.querySelector(".pill-text")

toggle.addEventListener("change", async () => {
    try {
        const data = await api("/setup/debug/toggle", "POST", { enabled: toggle.checked })
        updateToggleUI(data.enabled)
    } catch (err) {
        toggle.checked = !toggle.checked
    }
})

function updateToggleUI(enabled) {
    toggle.checked = enabled
    toggleLabel.textContent = enabled ? "Intercept ON" : "Intercept OFF"
    if (enabled && !_pollTimer) startPolling()
    if (!enabled) stopPolling()
}

// ── Polling ──────────────────────────────────────────────────────────────────

function startPolling() {
    poll()
    _pollTimer = setInterval(poll, 2000)
}

function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null }
}

async function poll() {
    try {
        const data = await api("/setup/debug/status")
        updateToggleUI(data.enabled)
        renderQueue(data.held || [])
        loadLog()
    } catch { /* silent */ }
}

// ── Queue ────────────────────────────────────────────────────────────────────

function renderQueue(held) {
    const list = document.getElementById("queue-list")
    const empty = document.getElementById("queue-empty")
    const countBadge = document.getElementById("queue-count")

    countBadge.textContent = held.length
    countBadge.className = held.length ? "badge active" : "badge"

    if (!held.length) {
        empty.classList.remove("hidden")
        // clear cards but keep empty
        list.querySelectorAll(".queue-card").forEach(c => c.remove())
        return
    }

    empty.classList.add("hidden")

    // build a set of current IDs
    const currentIds = new Set(held.map(h => h.requestId))

    // remove cards no longer in queue
    list.querySelectorAll(".queue-card").forEach(card => {
        if (!currentIds.has(card.dataset.id)) card.remove()
    })

    for (const h of held) {
        let card = list.querySelector(`.queue-card[data-id="${h.requestId}"]`)
        if (!card) {
            card = document.createElement("div")
            card.className = "queue-card"
            card.dataset.id = h.requestId
            card.addEventListener("click", () => selectMessage(h))
            list.appendChild(card)
        }

        const status = h.preview.status
        const intentGate = (h.preview.gates || []).find(g => g.id === "llm_intent" || g.id === "heuristic")
        const intent = intentGate?.output?.intent || status

        card.innerHTML = `
            <div class="queue-card-head">
                <span class="queue-phone">${esc(h.phone.replace(/@.*$/, "").slice(-10))}</span>
                <span class="queue-age">${fmtAge(h.age)}</span>
            </div>
            <div class="queue-msg">${esc(h.message)}</div>
            <div class="queue-intent">
                <span class="status-dot ${status === "awaiting_approval" ? "awaiting" : status}"></span>
                <span class="intent-tag">${esc(intent)}</span>
            </div>
        `

        if (_selected === h.requestId) card.classList.add("selected")
        else card.classList.remove("selected")
    }

    // if selected message is gone, update inspector
    if (_selected && !currentIds.has(_selected)) {
        _selected = null
        showEmptyInspector()
    }

    // auto-refresh the selected message's age
    if (_selected) {
        const h = held.find(x => x.requestId === _selected)
        if (h) {
            document.getElementById("ins-age").textContent = fmtAge(h.age)
        }
    }
}

// ── Inspector ────────────────────────────────────────────────────────────────

function showEmptyInspector() {
    document.getElementById("inspector-empty").classList.remove("hidden")
    document.getElementById("inspector-content").classList.add("hidden")
    resetAllGates()
}

function resetAllGates() {
    for (const id of GATE_IDS) {
        const gate = document.getElementById(`gate-${id}`)
        gate.dataset.status = "idle"
        gate.classList.remove("open")
        document.getElementById(`badge-${id}`).textContent = "—"
        document.getElementById(`body-${id}`).innerHTML = ""
    }
}

function selectMessage(held) {
    _selected = held.requestId

    // highlight in queue
    document.querySelectorAll(".queue-card").forEach(c => {
        c.classList.toggle("selected", c.dataset.id === _selected)
    })

    document.getElementById("inspector-empty").classList.add("hidden")
    document.getElementById("inspector-content").classList.remove("hidden")

    const p = held.preview
    document.getElementById("ins-phone").textContent = held.phone.replace(/@.*$/, "")
    document.getElementById("ins-age").textContent = fmtAge(held.age)
    document.getElementById("ins-message").textContent = held.message

    // render actions
    renderActions(held)

    // reset all gates first
    resetAllGates()

    // populate each gate from the preview
    const gateMap = {}
    for (const g of (p.gates || [])) gateMap[g.id] = g

    for (const id of GATE_IDS) {
        const g = gateMap[id]
        const el = document.getElementById(`gate-${id}`)
        const badge = document.getElementById(`badge-${id}`)
        const body = document.getElementById(`body-${id}`)

        if (!g) {
            el.dataset.status = "idle"
            badge.textContent = "—"
            body.innerHTML = '<p class="gate-detail">Gate not reached.</p>'
            continue
        }

        el.dataset.status = g.status
        badge.textContent = STATUS_LABELS[g.status] || g.status.toUpperCase()
        el.classList.add("open")

        let html = `<p class="gate-detail">${esc(g.detail)}</p>`
        html += `<p class="muted" style="margin-bottom:8px">Duration: ${g.duration}</p>`

        // input section
        html += renderKvSection("Input", g.input)

        // output section
        html += renderKvSection("Output", g.output)

        // policy checks
        if (g.output?.checks) {
            html += `<div class="gate-section"><div class="gate-section-label">Policy Checks</div><ul class="gate-checks">`
            for (const c of g.output.checks) {
                html += `<li>${c.passed ? "✅" : "❌"} <code>${esc(c.rule)}</code> — ${esc(c.detail || "")}</li>`
            }
            html += `</ul></div>`
        }

        // LLM prompt
        if (g.llmRequest) {
            html += `<div class="gate-section"><div class="gate-section-label">LLM Request (exact prompt sent)</div>`
            html += `<div class="llm-prompt-block">${esc(g.llmRequest)}</div></div>`
        }

        body.innerHTML = html
    }
}

function renderKvSection(label, obj) {
    if (!obj || typeof obj !== "object") return ""
    const entries = Object.entries(obj).filter(([k]) => k !== "checks")
    if (!entries.length) return ""
    let html = `<div class="gate-section"><div class="gate-section-label">${label}</div><dl class="gate-kv">`
    for (const [k, v] of entries) {
        const val = v === null ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v)
        html += `<dt>${esc(k)}</dt><dd><code>${esc(val)}</code></dd>`
    }
    html += `</dl></div>`
    return html
}

function renderActions(held) {
    const container = document.getElementById("ins-actions")
    const status = held.preview.status

    if (status === "awaiting_approval") {
        container.innerHTML = `
            <button class="btn-approve" id="btn-approve">✓ Approve & Send</button>
            <button class="btn-reject" id="btn-reject">✗ Reject</button>
        `
        document.getElementById("btn-approve").addEventListener("click", () => doApprove(held.requestId))
        document.getElementById("btn-reject").addEventListener("click", () => doReject(held.requestId))
    } else if (status === "blocked" || status === "policy_blocked" || status === "no_handler") {
        container.innerHTML = `<button class="btn-rejected" disabled>${status.replace(/_/g, " ").toUpperCase()}</button>`
    } else {
        container.innerHTML = ""
    }
}

async function doApprove(requestId) {
    const btn = document.getElementById("btn-approve")
    if (!btn) return
    btn.disabled = true
    btn.textContent = "Executing…"
    try {
        const data = await api("/setup/debug/approve", "POST", { requestId })
        document.getElementById("ins-actions").innerHTML =
            `<button class="btn-executed" disabled>✓ SENT</button><span class="muted">${esc((data.response || "").slice(0, 120))}</span>`
        _selected = null
        poll()
    } catch (err) {
        btn.disabled = false
        btn.textContent = "✓ Approve & Send"
    }
}

async function doReject(requestId) {
    const btn = document.getElementById("btn-reject")
    if (!btn) return
    btn.disabled = true
    try {
        await api("/setup/debug/reject", "POST", { requestId })
        document.getElementById("ins-actions").innerHTML = `<button class="btn-rejected" disabled>REJECTED</button>`
        _selected = null
        poll()
    } catch {
        btn.disabled = false
    }
}

// ── Gate toggle ──────────────────────────────────────────────────────────────

document.getElementById("gates-container").addEventListener("click", (e) => {
    const head = e.target.closest(".gate-head")
    if (!head) return
    head.closest(".gate").classList.toggle("open")
})

// ── Message Log (always-on) ──────────────────────────────────────────────────

async function loadLog() {
    try {
        const data = await api("/setup/debug/log?limit=50")
        renderLog(data.log || [])
    } catch { /* silent */ }
}

function renderLog(entries) {
    const el = document.getElementById("msg-log")
    if (!el) return
    if (!entries.length) { el.innerHTML = '<div style="color:var(--muted,#666);padding:8px">No messages yet.</div>'; return }
    el.innerHTML = entries.map(function(e, i) {
        var ago = Math.round((Date.now() - e.ts) / 1000)
        var ageStr = ago < 60 ? ago + "s" : Math.floor(ago / 60) + "m"
        var isAdmin = e.intent === "admin"
        var isHeld = e.intent === "held"
        var hasPreview = !!e.preview
        var tag = isAdmin ? '<span style="background:#7c6ff7;color:#fff;padding:1px 5px;border-radius:3px;font-size:0.7rem">ADMIN</span>'
            : isHeld ? '<span style="background:#c59a27;color:#fff;padding:1px 5px;border-radius:3px;font-size:0.7rem">HELD</span>'
            : '<span style="background:#2a2a3a;padding:1px 5px;border-radius:3px;font-size:0.7rem">' + esc(e.intent || e.source || "customer") + '</span>'
        var cursor = hasPreview ? 'cursor:pointer' : ''
        return '<div class="log-entry" data-log-idx="' + i + '" style="padding:6px 0;border-bottom:1px solid var(--border,#222);' + cursor + '">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px">' +
            '<span style="font-family:monospace;color:var(--accent,#7c6ff7)">' + esc((e.phone || "").replace(/@.*$/, "").slice(-10)) + '</span>' +
            tag + (hasPreview ? '<span style="font-size:0.65rem;color:var(--muted,#666)">▶ pipeline</span>' : '') +
            '<span style="color:var(--muted,#666)">' + ageStr + '</span></div>' +
            '<div style="margin:3px 0;color:var(--fg,#eee)">' + esc((e.text || "").slice(0, 120)) + '</div>' +
            '<div style="color:var(--muted,#666);font-size:0.74rem">' + esc((e.response || "").slice(0, 150)) + '</div></div>'
    }).join("")
    _logEntries = entries
}

let _logEntries = []

document.getElementById("msg-log").addEventListener("click", function(e) {
    var row = e.target.closest(".log-entry")
    if (!row) return
    var idx = Number(row.dataset.logIdx)
    var entry = _logEntries[idx]
    if (!entry || !entry.preview) return
    _selected = null
    document.querySelectorAll(".queue-card").forEach(function(c) { c.classList.remove("selected") })
    selectMessage({ requestId: entry.preview.requestId, phone: entry.phone, message: entry.text, preview: entry.preview, age: Math.round((Date.now() - entry.ts) / 1000) })
})

document.getElementById("log-refresh").addEventListener("click", loadLog)

// ── Init ─────────────────────────────────────────────────────────────────────

;(async () => {
    try {
        const data = await api("/setup/debug/status")
        updateToggleUI(data.enabled)
        renderQueue(data.held || [])
        if (data.enabled) startPolling()
        loadLog()
        if (!data.enabled) setInterval(loadLog, 5000)
    } catch { /* page loaded without server */ }
})()
