function loginUrl() {
  return `/login?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`
}

async function api(url, method = "GET", body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) {
    window.location.href = loginUrl()
    throw new Error("Unauthorized")
  }
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

let activeWorkspace = "default"
let generateProgressTimer = null

function withWorkspace(url) {
  const joiner = url.includes("?") ? "&" : "?"
  return `${url}${joiner}workspace=${encodeURIComponent(activeWorkspace)}`
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "default"
}

function formDataToObject(form) {
  const fd = new FormData(form)
  const data = Object.fromEntries(fd.entries())
  data.scrapeWebsite = form.elements.scrapeWebsite.checked
  return data
}

function applyProfile(form, profile) {
  for (const [key, value] of Object.entries(profile || {})) {
    const field = form.elements[key]
    if (!field) continue
    if (field.type === "checkbox") field.checked = !!value
    else field.value = value || ""
  }
}

function populateWorkspaceSelect(summary, currentWorkspace) {
  const select = document.getElementById("workspace-select")
  select.innerHTML = ""
  const workspaces = summary.workspaces && summary.workspaces.length
    ? summary.workspaces
    : [{ workspaceId: currentWorkspace || "default", businessName: currentWorkspace || "default" }]
  for (const workspace of workspaces) {
    const option = document.createElement("option")
    option.value = workspace.workspaceId
    option.textContent = workspace.businessName
      ? `${workspace.businessName} (${workspace.workspaceId})`
      : workspace.workspaceId
    if (workspace.workspaceId === currentWorkspace) option.selected = true
    select.appendChild(option)
  }
  document.getElementById("active-workspace-label").textContent = currentWorkspace || "default"
}

function fillList(id, items) {
  const el = document.getElementById(id)
  el.innerHTML = ""
  const list = items && items.length ? items : ["Nothing yet"]
  for (const item of list) {
    const li = document.createElement("li")
    li.textContent = item
    el.appendChild(li)
  }
}

function setStatus(message) {
  document.getElementById("status").textContent = message
}

function setText(id, text) {
  const el = document.getElementById(id)
  if (el) el.textContent = text
}

function setProgress(percent, label) {
  const shell = document.getElementById("generate-progress")
  shell.classList.remove("hidden")
  shell.setAttribute("aria-hidden", "false")
  document.getElementById("generate-progress-bar").style.width = `${percent}%`
  setText("generate-progress-value", `${Math.round(percent)}%`)
  if (label) setText("generate-progress-label", label)
}

function startGenerateProgress() {
  if (generateProgressTimer) clearInterval(generateProgressTimer)
  let progress = 8
  setProgress(progress, "Gathering business context…")
  generateProgressTimer = setInterval(() => {
    if (progress < 32) {
      progress += 8
      setProgress(progress, "Gathering business context…")
      return
    }
    if (progress < 62) {
      progress += 5
      setProgress(progress, "Generating manifests, FAQs, policy, and schema…")
      return
    }
    if (progress < 86) {
      progress += 2
      setProgress(progress, "Polishing the draft pack…")
    }
  }, 500)
}

function finishGenerateProgress(success = true) {
  if (generateProgressTimer) {
    clearInterval(generateProgressTimer)
    generateProgressTimer = null
  }
  setProgress(100, success ? "Draft generation complete." : "Draft generation failed.")
  window.setTimeout(() => {
    document.getElementById("generate-progress").classList.add("hidden")
    document.getElementById("generate-progress").setAttribute("aria-hidden", "true")
  }, success ? 1200 : 2200)
}

function appendChatMessage(role, text) {
  const log = document.getElementById("chat-log")
  const node = document.createElement("div")
  node.className = `chat-message ${role}`
  node.textContent = text
  log.appendChild(node)
  log.scrollTop = log.scrollHeight
}

function esc(str) {
  const d = document.createElement("div")
  d.textContent = str
  return d.innerHTML
}

function badgeClass(ok) { return ok ? "pass" : "fail" }
function badgeText(ok) { return ok ? "PASS" : "FAIL" }

function renderPipelineInspector(preview) {
  const panel = document.getElementById("pipeline-inspector")
  const body = document.getElementById("pi-body")
  panel.classList.remove("hidden")

  const p = preview
  let html = ""

  // Stage 1: Input
  html += `<div class="pi-stage">
    <div class="pi-stage-head">
      <span class="pi-badge info">1</span>
      <span class="pi-stage-label">Input</span>
    </div>
    <div class="pi-detail">
      <dl class="pi-kv">
        <dt>Raw</dt><dd><code>${esc(p.input.raw)}</code></dd>
        <dt>Sanitized</dt><dd><code>${p.input.sanitized ? esc(p.input.sanitized) : "—"}</code></dd>
      </dl>
    </div>
  </div>`

  // Stage 2: Sanitizer
  html += `<div class="pi-stage">
    <div class="pi-stage-head">
      <span class="pi-badge ${badgeClass(p.sanitizer.safe)}">2</span>
      <span class="pi-stage-label">Sanitizer</span>
      <span class="pi-badge ${badgeClass(p.sanitizer.safe)}">${p.sanitizer.safe ? "SAFE" : "BLOCKED"}</span>
    </div>
    <div class="pi-detail">
      ${p.sanitizer.safe ? "Message passed all security checks." : `Blocked: <code>${esc(p.sanitizer.reason)}</code>`}
    </div>
  </div>`

  if (p.status === "blocked" && !p.routing) {
    html += renderActions(p)
    body.innerHTML = html
    return
  }

  // Stage 3: Session
  if (p.session) {
    const active = p.session.active
    html += `<div class="pi-stage">
      <div class="pi-stage-head">
        <span class="pi-badge ${active ? "warn" : "info"}">3</span>
        <span class="pi-stage-label">Session</span>
        <span class="pi-badge ${active ? "warn" : "info"}">${active ? "ACTIVE" : "NONE"}</span>
      </div>
      <div class="pi-detail">
        ${active ? `Active ${esc(p.session.type)} session. ${esc(p.session.override)}` : "No active cart or support session."}
      </div>
    </div>`
  }

  // Stage 4: Routing / Intent
  if (p.routing) {
    html += `<div class="pi-stage">
      <div class="pi-stage-head">
        <span class="pi-badge info">4</span>
        <span class="pi-stage-label">Intent Classification</span>
      </div>
      <div class="pi-detail">
        <dl class="pi-kv">
          <dt>Intent</dt><dd><code>${esc(p.routing.intent)}</code></dd>
          <dt>Confidence</dt><dd>${(p.routing.confidence * 100).toFixed(0)}%</dd>
          <dt>Heuristic</dt><dd><code>${p.routing.heuristicMatch || "—"}</code></dd>
          <dt>Guard</dt><dd>${p.routing.guardApplied ? `<span class="pi-badge warn">FALLBACK</span> from <code>${esc(p.routing.originalIntent)}</code>` : "No fallback needed"}</dd>
        </dl>
        ${Object.keys(p.routing.filter || {}).length ? `<dl class="pi-kv" style="margin-top:8px"><dt>Filter</dt><dd><code>${esc(JSON.stringify(p.routing.filter))}</code></dd></dl>` : ""}
      </div>
    </div>`
  }

  // Stage 5: Policy
  if (p.policy) {
    html += `<div class="pi-stage">
      <div class="pi-stage-head">
        <span class="pi-badge ${badgeClass(p.policy.allowed)}">5</span>
        <span class="pi-stage-label">Policy Engine</span>
        <span class="pi-badge ${badgeClass(p.policy.allowed)}">${p.policy.allowed ? "ALLOWED" : "DENIED"}</span>
      </div>
      <div class="pi-detail">
        <ul class="pi-checks">
          ${(p.policy.checks || []).map(c => `<li>${c.result ? "✅" : "❌"} <code>${esc(c.rule)}</code>${c.detail ? " — " + esc(c.detail) : ""}</li>`).join("")}
        </ul>
      </div>
    </div>`
  }

  // Stage 6: Execution Plan
  if (p.plan && p.plan.length) {
    html += `<div class="pi-stage">
      <div class="pi-stage-head">
        <span class="pi-badge info">6</span>
        <span class="pi-stage-label">Execution Plan</span>
      </div>
      <div class="pi-detail">
        ${p.plan.map(s => `<div class="pi-plan-step">
          <dl class="pi-kv">
            <dt>Step ${s.step}</dt><dd><code>${esc(s.tool)}</code> (type: <code>${esc(s.type)}</code>)</dd>
            <dt>Risk</dt><dd><span class="pi-badge ${s.risk === "low" ? "pass" : s.risk === "medium" ? "warn" : "fail"}">${s.risk.toUpperCase()}</span></dd>
            <dt>Reason</dt><dd>${esc(s.reason)}</dd>
            <dt>Handler</dt><dd>${s.executable ? "✅ Resolved" : "❌ Missing"}</dd>
          </dl>
        </div>`).join("")}
      </div>
    </div>`
  }

  html += renderActions(p)
  body.innerHTML = html
  bindPipelineActions(p.requestId)
}

function renderActions(preview) {
  const s = preview.status
  if (s === "awaiting_approval") {
    return `<div class="pi-actions">
      <button class="primary small" id="pi-approve" data-id="${preview.requestId}">✓ Approve & Execute</button>
      <button class="ghost small" id="pi-reject" data-id="${preview.requestId}">✗ Reject</button>
      <span class="pi-status-tag awaiting">Awaiting Approval</span>
    </div>`
  }
  const cls = s === "blocked" || s === "policy_blocked" ? "blocked" : s === "no_handler" ? "blocked" : "info"
  return `<div class="pi-actions">
    <span class="pi-status-tag ${cls}">${s.replace(/_/g, " ").toUpperCase()}</span>
  </div>`
}

function bindPipelineActions(requestId) {
  const approveBtn = document.getElementById("pi-approve")
  const rejectBtn = document.getElementById("pi-reject")

  if (approveBtn) {
    approveBtn.addEventListener("click", async () => {
      approveBtn.disabled = true
      approveBtn.textContent = "Executing…"
      try {
        const data = await api("/setup/preview/approve", "POST", { requestId })
        appendChatMessage("agent", data.response || "Executed (no response)")
        const actions = approveBtn.closest(".pi-actions")
        actions.innerHTML = '<span class="pi-status-tag executed">EXECUTED</span>'
      } catch (err) {
        approveBtn.disabled = false
        approveBtn.textContent = "✓ Approve & Execute"
        appendChatMessage("agent", `Execution error: ${err.message}`)
      }
    })
  }

  if (rejectBtn) {
    rejectBtn.addEventListener("click", async () => {
      rejectBtn.disabled = true
      try {
        await api("/setup/preview/reject", "POST", { requestId })
        appendChatMessage("agent", "[Message rejected — not executed]")
        const actions = rejectBtn.closest(".pi-actions")
        actions.innerHTML = '<span class="pi-status-tag rejected">REJECTED</span>'
      } catch (err) {
        rejectBtn.disabled = false
      }
    })
  }
}

function renderGovernance(data) {
  const roleDescription = data.rolePolicy?.description ? `\n${data.rolePolicy.description}` : ""
  const maxRisk = data.rolePolicy?.maxRisk ? `\nMax risk: ${data.rolePolicy.maxRisk}` : ""
  setText("governance-summary", `Role: ${data.role || "unknown"}${roleDescription}${maxRisk}`)

  const workerItems = Object.entries(data.workers || {}).map(([name, tools]) => `${name}: ${tools.join(", ")}`)
  fillList("governance-workers", workerItems)

  const toolItems = Object.entries(data.tools || {}).slice(0, 16).map(([name, cfg]) =>
    `${name} (${cfg.category}, ${cfg.risk}, approval: ${cfg.approval})`
  )
  fillList("governance-tools", toolItems)
}

function renderApprovals(approvals) {
  const empty = document.getElementById("approvals-empty")
  const list = document.getElementById("approvals-list")
  list.innerHTML = ""

  if (!approvals || !approvals.length) {
    empty.textContent = "No pending approvals."
    empty.style.display = "block"
    return
  }

  empty.style.display = "none"
  for (const approval of approvals) {
    const card = document.createElement("article")
    card.className = "approval-item"

    const heading = document.createElement("div")
    heading.className = "approval-head"
    heading.innerHTML = `<strong>${approval.tool}</strong><span>${approval.id}</span>`

    const body = document.createElement("div")
    body.className = "approval-body"
    body.innerHTML = `
      <p><strong>Status:</strong> ${approval.status}</p>
      <p><strong>Worker:</strong> ${approval.worker}</p>
      <p><strong>Created:</strong> ${approval.createdAt}</p>
      <p><strong>Reason:</strong> ${approval.reason || "Approval required"}</p>
      <p><strong>Task:</strong> ${approval.task}</p>
    `

    const actions = document.createElement("div")
    actions.className = "approval-actions"
    if (approval.status === "pending") {
      const approveBtn = document.createElement("button")
      approveBtn.type = "button"
      approveBtn.className = "primary small"
      approveBtn.dataset.approvalId = approval.id
      approveBtn.textContent = "Approve"
      actions.appendChild(approveBtn)
    } else {
      const approvedTag = document.createElement("span")
      approvedTag.className = "approval-tag"
      approvedTag.textContent = "Approved"
      actions.appendChild(approvedTag)
    }

    card.appendChild(heading)
    card.appendChild(body)
    card.appendChild(actions)
    list.appendChild(card)
  }
}

async function loadGovernance() {
  const data = await api(withWorkspace("/setup/governance"))
  renderGovernance(data)
}

async function loadApprovals() {
  const data = await api(withWorkspace("/setup/approvals"))
  renderApprovals(data.approvals || [])
}

async function loadDebugStatus() {
  try {
    const data = await api("/setup/debug/status")
    document.getElementById("wa-debug-toggle").checked = data.enabled
    setText("wa-debug-status", data.enabled
      ? `Interceptor ON — ${data.held.length} message${data.held.length !== 1 ? "s" : ""} held`
      : "Interceptor OFF — WhatsApp messages execute normally")
    renderHeldMessages(data.held || [])
  } catch {
    setText("wa-debug-status", "Could not load debug status")
  }
}

function renderHeldMessages(held) {
  const list = document.getElementById("wa-debug-list")
  list.innerHTML = ""
  if (!held.length) return

  for (const h of held) {
    const p = h.preview
    const card = document.createElement("article")
    card.className = "wa-held-card"

    const intentLabel = p.routing ? p.routing.intent : (p.status === "blocked" ? "BLOCKED" : "unknown")
    const confidence = p.routing ? `${(p.routing.confidence * 100).toFixed(0)}%` : "—"
    const policyOk = p.policy ? p.policy.allowed : false
    const risk = p.plan?.[0]?.risk || "—"
    const tool = p.plan?.[0]?.tool || "—"

    card.innerHTML = `
      <div class="wa-held-head">
        <strong>${esc(h.phone.replace(/@.*$/, ""))}</strong>
        <span class="wa-held-age">${esc(h.age)} ago • ${esc(p.requestId)}</span>
      </div>
      <div class="wa-held-message">${esc(h.message)}</div>
      <details class="wa-held-pipeline">
        <summary>Pipeline trace — intent: ${esc(intentLabel)} • confidence: ${confidence} • policy: ${policyOk ? "✅" : "❌"} • tool: ${esc(tool)} • risk: ${esc(risk)}</summary>
        <div class="pi-stage">
          <div class="pi-detail">
            <dl class="pi-kv">
              <dt>Raw</dt><dd><code>${esc(p.input.raw)}</code></dd>
              <dt>Sanitized</dt><dd><code>${p.input.sanitized || "—"}</code></dd>
              ${p.routing ? `<dt>Intent</dt><dd><code>${esc(p.routing.intent)}</code></dd>
              <dt>Heuristic</dt><dd><code>${p.routing.heuristicMatch || "—"}</code></dd>
              <dt>Filter</dt><dd><code>${esc(JSON.stringify(p.routing.filter || {}))}</code></dd>` : ""}
              ${p.policy ? `<dt>Policy</dt><dd>${p.policy.allowed ? "✅ Allowed" : "❌ Denied"}</dd>` : ""}
              ${p.plan?.[0] ? `<dt>Tool</dt><dd><code>${esc(p.plan[0].tool)}</code> (${esc(p.plan[0].type)})</dd>
              <dt>Risk</dt><dd><span class="pi-badge ${p.plan[0].risk === "low" ? "pass" : p.plan[0].risk === "medium" ? "warn" : "fail"}">${p.plan[0].risk.toUpperCase()}</span></dd>` : ""}
            </dl>
          </div>
        </div>
      </details>
      <div class="wa-held-actions">
        <button class="primary small wa-approve-btn" data-id="${p.requestId}">✓ Approve & Send</button>
        <button class="ghost small wa-reject-btn" data-id="${p.requestId}">✗ Reject</button>
        <span class="pi-status-tag awaiting">Held</span>
      </div>
    `
    list.appendChild(card)
  }
}

async function load() {
  const form = document.getElementById("profile-form")
  try {
    let data = await api(withWorkspace("/setup/profile"))
    console.log("[load] first fetch workspace:", activeWorkspace, "got activeWorkspace:", data.activeWorkspace, "businessName:", data.profile?.businessName)
    if (data.activeWorkspace && data.activeWorkspace !== activeWorkspace) {
      activeWorkspace = data.activeWorkspace
      data = await api(withWorkspace("/setup/profile"))
      console.log("[load] re-fetch workspace:", activeWorkspace, "businessName:", data.profile?.businessName)
    }
    activeWorkspace = data.activeWorkspace || activeWorkspace
    applyProfile(form, data.profile)
    fillList("files", data.draftFiles)
    populateWorkspaceSelect(data, activeWorkspace)
    setStatus("Profile loaded. Update the fields, save, then generate your draft agent pack.")
  } catch (err) {
    console.error("[load] profile fetch failed:", err)
    setStatus("Failed to load profile: " + err.message)
  }
  try { await loadGovernance() } catch (e) { console.error("[load] governance:", e) }
  try { await loadApprovals() } catch (e) { console.error("[load] approvals:", e) }
  try { await loadDebugStatus() } catch (e) { console.error("[load] debug:", e) }
  const log = document.getElementById("chat-log")
  log.innerHTML = ""
  appendChatMessage("agent", "Customer chat sandbox ready. Try a real customer-style question here.")
}

window.addEventListener("DOMContentLoaded", async () => {
  const form = document.getElementById("profile-form")
  document.getElementById("logout-btn").addEventListener("click", async () => {
    await api("/setup/logout", "POST", {})
    window.location.href = "/login"
  })
  await load()

  document.getElementById("workspace-apply-btn").addEventListener("click", async () => {
    const selected = document.getElementById("workspace-select").value
    const data = await api("/setup/workspace/select", "POST", { workspaceId: selected })
    activeWorkspace = data.activeWorkspace
    populateWorkspaceSelect(data, activeWorkspace)
    await load()
  })

  document.getElementById("workspace-create-btn").addEventListener("click", async () => {
    const input = document.getElementById("new-workspace-input")
    const proposed = slugify(input.value || form.elements.businessName.value || "default")
    const payload = formDataToObject(form)
    payload.workspaceId = proposed
    payload.businessName = payload.businessName || proposed
    await api("/setup/profile", "POST", payload)
    const data = await api("/setup/workspace/select", "POST", { workspaceId: proposed })
    activeWorkspace = data.activeWorkspace
    input.value = ""
    populateWorkspaceSelect(data, activeWorkspace)
    await load()
  })

  document.getElementById("refresh-governance-btn").addEventListener("click", async () => {
    await loadGovernance()
  })

  document.getElementById("refresh-approvals-btn").addEventListener("click", async () => {
    await loadApprovals()
  })

  document.getElementById("wa-debug-toggle").addEventListener("change", async (e) => {
    try {
      const data = await api("/setup/debug/toggle", "POST", { enabled: e.target.checked })
      await loadDebugStatus()
    } catch (err) {
      e.target.checked = !e.target.checked
      setText("wa-debug-status", `Toggle failed: ${err.message}`)
    }
  })

  document.getElementById("wa-debug-refresh").addEventListener("click", async () => {
    await loadDebugStatus()
  })

  document.getElementById("wa-debug-list").addEventListener("click", async (event) => {
    const approveBtn = event.target.closest(".wa-approve-btn")
    const rejectBtn = event.target.closest(".wa-reject-btn")

    if (approveBtn) {
      const id = approveBtn.dataset.id
      approveBtn.disabled = true
      approveBtn.textContent = "Executing\u2026"
      try {
        const data = await api("/setup/debug/approve", "POST", { requestId: id })
        const actions = approveBtn.closest(".wa-held-actions")
        actions.innerHTML = `<span class="pi-status-tag executed">SENT \u2014 ${esc(data.response?.slice(0, 80) || "executed")}</span>`
      } catch (err) {
        approveBtn.disabled = false
        approveBtn.textContent = "\u2713 Approve & Send"
        setText("wa-debug-status", `Approve failed: ${err.message}`)
      }
    }

    if (rejectBtn) {
      const id = rejectBtn.dataset.id
      rejectBtn.disabled = true
      try {
        await api("/setup/debug/reject", "POST", { requestId: id })
        const actions = rejectBtn.closest(".wa-held-actions")
        actions.innerHTML = '<span class="pi-status-tag rejected">REJECTED</span>'
      } catch (err) {
        rejectBtn.disabled = false
      }
    }
  })

  document.getElementById("save-btn").addEventListener("click", async () => {
    setStatus("Saving profile…")
    const payload = formDataToObject(form)
    payload.workspaceId = activeWorkspace
    await api("/setup/profile", "POST", payload)
    setStatus("Profile saved locally.")
  })

  document.getElementById("generate-btn").addEventListener("click", async () => {
    setStatus("Generating draft agent pack… this can take a little while.")
    startGenerateProgress()
    const payload = formDataToObject(form)
    payload.workspaceId = activeWorkspace
    try {
      const data = await api("/setup/generate", "POST", payload)
      fillList("files", data.draftFiles)
      fillList("intents", data.intents)
      fillList("faqs", data.faqTopics)
      finishGenerateProgress(true)
      setStatus(`Draft generated for "${data.slug}".\nDomain keywords generated: ${data.keywordCount}\nReview the draft files below, then promote when ready.`)
    } catch (err) {
      finishGenerateProgress(false)
      setStatus(`Draft generation failed.\n${err.message}`)
    }
  })

  document.getElementById("promote-btn").addEventListener("click", async () => {
    setStatus("Promoting draft to live config…")
    const data = await api("/setup/promote", "POST", { workspaceId: activeWorkspace })
    fillList("files", data.files)
    setStatus(`Promoted ${data.promoted} files to live config.\nRestart the agent transport to use the new business profile.`)
  })

  document.getElementById("admin-task-form").addEventListener("submit", async event => {
    event.preventDefault()
    const task = document.getElementById("admin-task-input").value.trim()
    const mode = document.getElementById("admin-task-mode").value
    if (!task) return
    setText("admin-task-status", "Running admin task…")
    setText("admin-task-output", "Working…")
    try {
      const response = await api("/setup/admin/run", "POST", { task, mode, workspaceId: activeWorkspace })
      setText("admin-task-status", `Completed in ${response.mode} mode for workspace ${response.workspaceId}.`)
      setText("admin-task-output", response.response || "No response")
      await loadApprovals()
    } catch (err) {
      setText("admin-task-status", `Admin task failed: ${err.message}`)
      setText("admin-task-output", `Error: ${err.message}`)
    }
  })

  document.getElementById("chat-form").addEventListener("submit", async event => {
    event.preventDefault()
    const phone = document.getElementById("chat-phone").value.trim()
    const input = document.getElementById("chat-input")
    const message = input.value.trim()
    if (!phone || !message) return
    appendChatMessage("user", message)
    input.value = ""

    const previewMode = document.getElementById("preview-mode-toggle").checked

    if (previewMode) {
      try {
        const data = await api("/setup/preview", "POST", { phone, message, workspaceId: activeWorkspace })
        renderPipelineInspector(data.preview)
      } catch (err) {
        appendChatMessage("agent", `Preview error: ${err.message}`)
      }
    } else {
      try {
        const data = await api("/setup/chat", "POST", { phone, message, workspaceId: activeWorkspace })
        appendChatMessage("agent", data.response || "No response")
      } catch (err) {
        appendChatMessage("agent", `Error: ${err.message}`)
      }
    }
  })

  document.getElementById("pi-close").addEventListener("click", () => {
    document.getElementById("pipeline-inspector").classList.add("hidden")
  })

  document.getElementById("approvals-list").addEventListener("click", async event => {
    const button = event.target.closest("button[data-approval-id]")
    if (!button) return
    const id = button.dataset.approvalId
    button.disabled = true
    button.textContent = "Approving…"
    try {
      await api("/setup/approvals/approve", "POST", { id, workspaceId: activeWorkspace })
      await loadApprovals()
      setText("admin-task-status", `Approved ${id}. Rerun the task with token ${id}.`)
    } catch (err) {
      button.disabled = false
      button.textContent = "Approve"
      setText("admin-task-status", `Approval failed: ${err.message}`)
    }
  })
})
