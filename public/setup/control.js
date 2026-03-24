/* global fetch */
"use strict"

let _currentPreview = null
let _history = []

// ── API ──────────────────────────────────────────────────────────────────────

async function api(url, method = "GET", body) {
    const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 401) { window.location.href = "/login"; throw new Error("Unauthorized") }
    return res.json()
}

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML }

// ── Auto Mode Toggle ─────────────────────────────────────────────────────────

const autoToggle = document.getElementById("auto-mode-toggle")

;(async () => {
    try {
        const data = await api("/setup/preview/policy")
        if (data.ok) autoToggle.checked = !!data.policy.autoMode
    } catch { /* ignore */ }
})()

autoToggle.addEventListener("change", async () => {
    try {
        await api("/setup/preview/policy", "POST", { autoMode: autoToggle.checked })
    } catch { autoToggle.checked = !autoToggle.checked }
})

// ── Preview ──────────────────────────────────────────────────────────────────

async function doPreview() {
    const phone = document.getElementById("phone-input").value.trim() || "control-panel"
    const message = document.getElementById("msg-input").value.trim()
    if (!message) return

    const btn = document.getElementById("btn-preview")
    btn.disabled = true; btn.textContent = "Analyzing…"

    try {
        const data = await api("/setup/preview", "POST", { phone, message })
        if (!data.ok || !data.preview) throw new Error(data.error || "Preview failed")
        _currentPreview = data.preview
        const autoResult = data.preview.autoExecuted ? data.preview.executionResult : null
        _history.unshift({ message, preview: data.preview, result: autoResult })
        renderHistory()
    renderPreview(data.preview)
    if (data.preview.autoExecuted && data.preview.executionResult) {
      renderResult(data.preview.executionResult)
    }
  } catch (err) {
    alert("Preview failed: " + err.message)
  } finally {
    btn.disabled = false; btn.textContent = "Preview"
  }
}

document.addEventListener("DOMContentLoaded", () => {
  loadFlowConfigs();
});

document.getElementById("btn-preview").addEventListener("click", doPreview)
document.getElementById("msg-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") doPreview()
})

function $(id) { return document.getElementById(id) }

// Initial load
// loadFlowConfigs(); - moved to models.js

// ── Render Preview ───────────────────────────────────────────────────────────

function renderPreview(p) {
    document.getElementById("empty-state").classList.add("hidden")
    show("panel-input"); show("panel-intent"); show("panel-policy"); show("panel-plan"); show("panel-gates")
    hide("panel-result")

    const mode = p.execution?.mode || "preview"
    const finalRisk = p.execution?.finalRisk || "low"

    // Summary panel
    if (p.summary) {
        show("panel-summary")
        document.getElementById("summary-title").textContent = p.summary.title || ""
        const stepsOl = document.getElementById("summary-steps")
        stepsOl.innerHTML = (p.summary.steps || []).map(s => `<li>${esc(s)}</li>`).join("")
        const riskEl = document.getElementById("summary-risk")
        riskEl.textContent = finalRisk.toUpperCase()
        riskEl.className = `risk-badge ${finalRisk}`
        const modeEl = document.getElementById("summary-mode")
        modeEl.textContent = mode.toUpperCase()
        modeEl.className = `mode-badge ${mode}`
    } else { hide("panel-summary") }

    // Explanation panel
    if (p.explanation) {
        show("panel-explanation")
        document.getElementById("explain-intent").textContent = p.explanation.intent || ""
        document.getElementById("explain-tool").textContent = p.explanation.tool || ""
        document.getElementById("explain-risk").textContent = p.explanation.risk || ""
        const planEl = document.getElementById("explain-plan")
        const flowEl = document.getElementById("explain-flow")
        if (p.explanation.plan) {
            planEl.textContent = p.explanation.plan
            flowEl.textContent = p.explanation.flow || ""
            document.getElementById("explain-plan-row").classList.remove("hidden")
            document.getElementById("explain-flow-row").classList.remove("hidden")
        } else {
            document.getElementById("explain-plan-row").classList.add("hidden")
            document.getElementById("explain-flow-row").classList.add("hidden")
        }
    } else { hide("panel-explanation") }

    // Auto-execute banner
    if (p.autoExecuted) {
        document.getElementById("auto-banner-text").textContent = `Auto-executed (${finalRisk} risk)`
        show("auto-banner")
    } else { hide("auto-banner") }

    // Blocked banner
    if (mode === "blocked") {
        const reason = p.policy?.checks?.find(c => !c.passed)?.detail || `${finalRisk} risk — execution blocked by policy`
        document.getElementById("blocked-text").textContent = reason
        show("blocked-banner")
    } else { hide("blocked-banner") }

    // Panel 1: Input
    const sanitizerGate = p.gates?.find(g => g.id === "sanitizer")
    document.getElementById("trace-raw").textContent = p.input?.raw || ""
    document.getElementById("trace-sanitized").textContent = sanitizerGate?.output?.sanitized || p.input?.sanitized || "(blocked)"
    const statusEl = document.getElementById("trace-status")
    statusEl.textContent = sanitizerGate?.status?.toUpperCase() || "—"
    statusEl.className = "badge " + (sanitizerGate?.status || "")

    // Panel 2: Intent
    document.getElementById("intent-name").textContent = p.routing?.intent || "—"
    const srcEl = document.getElementById("intent-source")
    srcEl.textContent = p.routing?.source || "—"
    srcEl.className = "badge " + (p.routing?.source || "")
    document.getElementById("intent-filter").textContent = p.routing?.filter ? JSON.stringify(p.routing.filter, null, 2) : "{}"

    // gate chips
    const gatesMini = document.getElementById("intent-gates")
    gatesMini.innerHTML = (p.gates || []).map(g =>
        `<span class="gate-chip ${g.status}" title="${esc(g.detail || "")}">${esc(g.name)}</span>`
    ).join("")

    // Panel 3: Policy
    const policyEl = document.getElementById("policy-status")
    policyEl.textContent = p.policy?.allowed ? "✓ ALL CHECKS PASSED" : "✗ BLOCKED"
    policyEl.className = "policy-status " + (p.policy?.allowed ? "allowed" : "denied")
    const checkList = document.getElementById("policy-checks")
    checkList.innerHTML = (p.policy?.checks || []).map(c =>
        `<li>${c.passed ? "✅" : "❌"} <code>${esc(c.rule)}</code> — ${esc(c.detail || "")}</li>`
    ).join("")

    // Panel 4: Plan
    renderPlan(p.plan || [])

    // Action bar
    const actionBar = document.getElementById("action-bar")
    const approvalWarning = document.getElementById("approval-warning")
    if (p.status === "awaiting_approval") {
        show("action-bar")
        if (mode === "approval") {
            actionBar.classList.add("highlight")
            approvalWarning.classList.remove("hidden")
        } else {
            actionBar.classList.remove("highlight")
            approvalWarning.classList.add("hidden")
        }
    } else {
        hide("action-bar")
        actionBar.classList.remove("highlight")
        approvalWarning.classList.add("hidden")
    }

    // If auto-executed, show result directly
    if (p.autoExecuted) { hide("action-bar") }

    // Gates detail
    renderGatesDetail(p.gates || [])
}

function renderPlan(plan) {
    const container = document.getElementById("plan-steps")
    const emptyEl = document.getElementById("plan-empty")

    if (!plan.length) {
        container.innerHTML = ""
        emptyEl.classList.remove("hidden")
        return
    }
    emptyEl.classList.add("hidden")

    const isMulti = plan.length > 1

    container.innerHTML = plan.map((step, i) => {
        const depLabel = step.dependsOn ? `<span class="step-dep">← uses step ${step.dependsOn} output</span>` : ""
        const connector = (isMulti && i < plan.length - 1) ? `<div class="step-connector"><span class="connector-arrow">↓</span></div>` : ""
        return `
        <div class="step-card" data-step="${i}">
            <div class="step-head" onclick="this.parentElement.classList.toggle('open')">
                <span class="step-num">${step.step}</span>
                <span class="step-tool">${esc(step.tool)}</span>
                <span class="step-type">${esc(step.toolType)}</span>
                ${depLabel}
                <span class="step-risk"><span class="risk-${step.risk}">${(step.risk || "unknown").toUpperCase()}</span></span>
            </div>
            <div class="step-body">
                <div class="step-reason">${esc(step.reason || "")}</div>
                ${step.dependsOn ? `<div class="step-dep-detail">🔗 Depends on step ${step.dependsOn} — output will be passed as _previousOutput</div>` : ""}
                <div class="step-input-label">Input (editable JSON)</div>
                <textarea class="step-input-editor" data-step="${i}">${JSON.stringify(step.input || {}, null, 2)}</textarea>
            </div>
        </div>
        ${connector}`
    }).join("")

    // auto-expand first step
    const first = container.querySelector(".step-card")
    if (first) first.classList.add("open")
}

function renderGatesDetail(gates) {
    const container = document.getElementById("gates-detail")
    container.innerHTML = gates.map(g => {
        let html = `<div class="gate-detail-card">
            <div class="gate-detail-head">
                <span class="badge ${g.status}">${(g.status || "").toUpperCase()}</span>
                <span class="gate-name">${esc(g.name)}</span>
                <span class="gate-dur">${g.duration || ""}</span>
            </div>
            <div class="gate-detail-text">${esc(g.detail || "")}</div>
            <dl class="gate-kv">`

        // render input
        if (g.input && typeof g.input === "object") {
            for (const [k, v] of Object.entries(g.input)) {
                const val = v === null ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v)
                html += `<dt>${esc(k)}</dt><dd><code>${esc(val)}</code></dd>`
            }
        }
        // render output
        if (g.output && typeof g.output === "object") {
            for (const [k, v] of Object.entries(g.output)) {
                if (k === "checks") continue
                const val = v === null ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v)
                html += `<dt>${esc(k)}</dt><dd><code>${esc(val)}</code></dd>`
            }
        }
        html += `</dl>`

        // policy checks
        if (g.output?.checks) {
            html += `<ul class="check-list" style="margin-top:8px">`
            for (const c of g.output.checks) {
                html += `<li>${c.passed ? "✅" : "❌"} <code>${esc(c.rule)}</code> — ${esc(c.detail || "")}</li>`
            }
            html += `</ul>`
        }

        // LLM prompt
        if (g.llmRequest) {
            html += `<div class="llm-prompt-block">${esc(g.llmRequest)}</div>`
        }

        html += `</div>`
        return html
    }).join("")
}

// ── Approve / Reject ─────────────────────────────────────────────────────────

document.getElementById("btn-approve").addEventListener("click", async () => {
    if (!_currentPreview) return
    const btn = document.getElementById("btn-approve")
    btn.disabled = true; btn.textContent = "Executing…"

    // collect possibly-edited plan from textareas
    const modifiedPlan = collectEditedPlan()

    try {
        const data = await api("/setup/preview/approve", "POST", {
            requestId: _currentPreview.requestId,
            modifiedPlan,
        })
        if (data.error) throw new Error(data.error)
        hide("action-bar")
        renderResult(data)
        // update history
        if (_history.length) _history[0].result = data
        renderHistory()
    } catch (err) {
        alert("Execution failed: " + err.message)
    } finally {
        btn.disabled = false; btn.textContent = "✓ Approve & Execute"
    }
})

document.getElementById("btn-reject").addEventListener("click", async () => {
    if (!_currentPreview) return
    try {
        await api("/setup/preview/reject", "POST", { requestId: _currentPreview.requestId })
        hide("action-bar")
        _currentPreview.status = "rejected"
        if (_history.length) _history[0].preview.status = "rejected"
        renderHistory()
        const resultBody = document.getElementById("result-body")
        resultBody.innerHTML = `<div class="policy-status denied">✗ REJECTED</div>`
        show("panel-result")
    } catch (err) {
        alert("Reject failed: " + err.message)
    }
})

function collectEditedPlan() {
    if (!_currentPreview?.plan?.length) return null
    const editors = document.querySelectorAll(".step-input-editor")
    if (!editors.length) return null

    const plan = _currentPreview.plan.map((step, i) => {
        const editor = editors[i]
        let input = step.input
        if (editor) {
            try { input = JSON.parse(editor.value) } catch { /* keep original */ }
        }
        return { ...step, input }
    })
    return plan
}

function renderResult(data) {
    show("panel-result")
    const body = document.getElementById("result-body")

    if (!data.steps || !data.steps.length) {
        body.innerHTML = `<div class="result-response">${esc(data.response || "No response.")}</div>`
        return
    }

    body.innerHTML = data.steps.map((s, i) => {
        const depNote = s.dependsOn ? `<span class="result-dep">← from step ${s.dependsOn}</span>` : ""
        const connector = (i < data.steps.length - 1) ? `<div class="step-connector"><span class="connector-arrow">↓</span></div>` : ""
        return `
        <div class="result-step">
            <div class="result-step-head">
                <span class="badge ${s.status}">${(s.status || "").toUpperCase()}</span>
                <strong>${esc(s.tool || "")}</strong>
                ${depNote}
                <span style="color:#606078;font-size:0.8rem;margin-left:auto">${s.duration || ""}</span>
            </div>
            <div class="result-response">${esc(s.response || s.error || "No output.")}</div>
        </div>
        ${connector}`
    }).join("")
}

// ── History ──────────────────────────────────────────────────────────────────

function renderHistory() {
    const list = document.getElementById("history-list")
    list.innerHTML = _history.map((h, i) => `
        <div class="history-item ${i === 0 ? "active" : ""}" data-idx="${i}">
            <div class="history-msg">${esc(h.message)}</div>
            <div class="history-meta">
                <span class="history-intent">${esc(h.preview?.routing?.intent || "—")}</span>
                <span class="history-status ${h.result ? "executed" : (h.preview?.status || "")}">${h.result ? "DONE" : (h.preview?.status || "").replace(/_/g, " ").toUpperCase()}</span>
            </div>
        </div>
    `).join("")

    list.querySelectorAll(".history-item").forEach(el => {
        el.addEventListener("click", () => {
            const idx = parseInt(el.dataset.idx)
            const entry = _history[idx]
            if (!entry) return
            _currentPreview = entry.preview
            list.querySelectorAll(".history-item").forEach(e => e.classList.remove("active"))
            el.classList.add("active")
            renderPreview(entry.preview)
            if (entry.result) {
                hide("action-bar")
                renderResult(entry.result)
            }
        })
    })
}

// ── Workflows ─────────────────────────────────────────────────────────────────

async function loadWorkflows() {
    try {
        const data = await api("/setup/workflows")
        if (!data.ok) return
        renderWorkflowList(data.workflows || [])
    } catch { /* ignore */ }
}

function renderWorkflowList(workflows) {
    const list = document.getElementById("workflow-list")
    if (!workflows.length) { list.innerHTML = `<div class="wf-empty">No saved workflows</div>`; return }
    list.innerHTML = workflows.map(w => `
        <div class="wf-item" data-id="${esc(w.id)}">
            <div class="wf-name">${esc(w.name)}</div>
            <div class="wf-meta">${w.steps} step${w.steps > 1 ? "s" : ""}</div>
            <div class="wf-actions">
                <button class="wf-run" data-id="${esc(w.id)}" title="Run">▶</button>
                <button class="wf-del" data-id="${esc(w.id)}" title="Delete">✗</button>
            </div>
        </div>
    `).join("")

    list.querySelectorAll(".wf-run").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            e.stopPropagation()
            const id = btn.dataset.id
            const phone = document.getElementById("phone-input").value.trim() || "workflow-runner"
            // check for {{params}} in the workflow — prompt user
            const wf = workflows.find(w => w.id === id)
            let inputs = {}
            if (wf) {
                const paramStr = prompt(`Run workflow "${wf.name}"\n\nEnter parameters as JSON (or leave empty):`, "{}")
                if (paramStr === null) return
                try { inputs = JSON.parse(paramStr) } catch { inputs = {} }
            }
            btn.disabled = true; btn.textContent = "…"
            try {
                const data = await api("/setup/workflows/run", "POST", { workflowId: id, phone, inputs })
                if (!data.ok || !data.preview) throw new Error(data.error || "Run failed")
                _currentPreview = data.preview
                const autoResult = data.preview.autoExecuted ? data.preview.executionResult : null
                _history.unshift({ message: `[wf] ${wf?.name || id}`, preview: data.preview, result: autoResult })
                renderHistory()
                renderPreview(data.preview)
                if (data.preview.autoExecuted && data.preview.executionResult) renderResult(data.preview.executionResult)
            } catch (err) { alert("Workflow run failed: " + err.message) }
            finally { btn.disabled = false; btn.textContent = "▶" }
        })
    })

    list.querySelectorAll(".wf-del").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            e.stopPropagation()
            if (!confirm("Delete this workflow?")) return
            try {
                await api(`/setup/workflows/${btn.dataset.id}`, "DELETE")
                loadWorkflows()
            } catch (err) { alert("Delete failed: " + err.message) }
        })
    })
}

document.getElementById("btn-save-workflow").addEventListener("click", async () => {
    if (!_currentPreview?.plan?.length) { alert("No plan to save."); return }
    const name = prompt("Workflow name:")
    if (!name) return
    const description = prompt("Description (optional):", "") || ""
    try {
        const plan = collectEditedPlan() || _currentPreview.plan
        const data = await api("/setup/workflows/save", "POST", { name, description, plan })
        if (!data.ok) throw new Error(data.error || "Save failed")
        alert(`Workflow "${name}" saved!`)
        loadWorkflows()
    } catch (err) { alert("Save failed: " + err.message) }
})

loadWorkflows()

// ── Helpers ───────────────────────────────────────────────────────────────────

function show(id) { document.getElementById(id).classList.remove("hidden") }
function hide(id) { document.getElementById(id).classList.add("hidden") }
