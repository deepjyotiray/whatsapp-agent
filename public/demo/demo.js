"use strict"

const $ = (id) => document.getElementById(id)

const SCENARIOS = {
  customer_menu: {
    flow: "customer",
    prompt: "Show me high-protein meals under ₹250",
    summary: "Customer flow stays inside the menu domain, routes through policy checks, then maps to the customer tool/backend strategy.",
    messages: [
      { role: "user", label: "Customer", text: "Show me high-protein meals under ₹250" },
      { role: "system", label: "Policy", text: "Domain match confirmed. Intent candidate: menu discovery. Structured filters extracted." },
      { role: "live", label: "Runtime", text: "Customer flow decides whether to use manifest tools or backend mode based on configured execution strategy." },
    ],
    timeline: [
      { title: "Sanitize", detail: "Raw input is checked before any flow logic runs." },
      { title: "Policy Gate", detail: "Domain and allowed-intent checks keep the request inside customer scope." },
      { title: "Route", detail: "Tool-first or backend-first decision happens using customer execution config." },
      { title: "Respond", detail: "Menu results or conversational answer is returned to the customer." },
    ],
  },
  admin_metrics: {
    flow: "admin",
    prompt: "ray 123456 what were this month's expenses and income?",
    summary: "Admin flow accepts the privileged command, validates flow access, then governance constrains which tools the worker can use.",
    messages: [
      { role: "user", label: "Admin", text: "ray 123456 what were this month's expenses and income?" },
      { role: "system", label: "Auth", text: "Hotword, PIN, and allowed-number gates identify the request as admin flow." },
      { role: "live", label: "Governance", text: "Only role-safe tools like query_db or backend query mode are permitted for the task." },
    ],
    timeline: [
      { title: "Flow Access", detail: "Hotword + PIN + number allowlist determine who may enter admin flow." },
      { title: "Execution Mode", detail: "Admin routing decides between direct tools and backend mode." },
      { title: "Governance", detail: "Role, worker, risk ceiling, and approval mode are checked before each tool call." },
      { title: "Audit", detail: "Governance decisions and approvals are recorded in workspace logs." },
    ],
  },
  agent_update: {
    flow: "agent",
    prompt: "agent 123456 update order ORD-104 to Delivered",
    summary: "Agent flow is the strongest control surface: it can plan and act, but each tool is still filtered by governance and approval policy.",
    messages: [
      { role: "user", label: "Operator", text: "agent 123456 update order ORD-104 to Delivered" },
      { role: "system", label: "Planner", text: "Task classified as a mutating operational request. Agentic execution path selected." },
      { role: "live", label: "Approval", text: "If the chosen tool requires explicit approval, an approval token is created before execution can continue." },
    ],
    timeline: [
      { title: "Agent Entry", detail: "Agent keyword and PIN move the request into the agent surface." },
      { title: "Plan", detail: "Workers and preferred tools are chosen for safe execution." },
      { title: "Govern", detail: "Each tool call is checked against worker-tool topology and role permissions." },
      { title: "Approve", detail: "High-risk mutations can pause until explicit approval is granted." },
    ],
  },
}

let runtimeMeta = window.__DEMO_META__ || null
let activeScenarioKey = "customer_menu"
let cycleIndex = 0

function escapeHtml(value) {
  const div = document.createElement("div")
  div.textContent = value == null ? "" : String(value)
  return div.innerHTML
}

function statusClass(status) {
  return `status-${status || "unknown"}`
}

function inferScenarioFromInput(text) {
  const value = String(text || "").toLowerCase()
  if (/^(ray|admin)\b|expense|income|revenue|orders?/.test(value)) return "admin_metrics"
  if (/^(agent)\b|approve|update order|delivered|run_shell|tool/.test(value)) return "agent_update"
  return "customer_menu"
}

function flowMeta(flowName) {
  return runtimeMeta?.flows?.[flowName] || { status: "unknown", backend: "direct", probes: [], tools: [] }
}

function renderRuntimeStrip(meta) {
  if ($("hero-lede-inline")) $("hero-lede-inline").textContent = meta?.lede || "Explore live runtime flow behavior."
  $("runtime-health").textContent = meta?.health?.status === "ok" ? `Online · ${meta.health.agent || "agent"}` : (meta?.health?.status || "unknown")
  $("runtime-pack").textContent = meta?.domainPack?.name || meta?.profile?.domainPack || "No domain pack"
  $("runtime-workspace").textContent = meta?.workspaceId || "unknown"
  $("runtime-time").textContent = meta?.generatedAt ? new Date(meta.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "n/a"
}

function updateScenarioButtons(activeKey) {
  document.querySelectorAll(".mode-btn[data-scenario]").forEach(function(button) {
    button.classList.toggle("active", button.getAttribute("data-scenario") === activeKey)
  })
}

function renderMessages(messages) {
  $("message-stack").innerHTML = messages.map(function(message, index) {
    return `<article class="message ${escapeHtml(message.role)}" style="animation-delay:${index * 90}ms">
      <small>${escapeHtml(message.label)}</small>
      ${escapeHtml(message.text)}
    </article>`
  }).join("")
}

function renderTimeline(steps) {
  $("timeline").innerHTML = steps.map(function(step, index) {
    return `<div class="timeline-step ${index === 1 ? "active" : ""}">
      <strong>${escapeHtml(step.title)}</strong>
      <small>${escapeHtml(step.detail)}</small>
    </div>`
  }).join("")
}

function renderAnalysis(scenarioKey) {
  const scenario = SCENARIOS[scenarioKey]
  const flow = flowMeta(scenario.flow)
  $("analysis-flow").textContent = `${scenario.flow[0].toUpperCase()}${scenario.flow.slice(1)} · ${flow.status || "unknown"}`
  $("analysis-summary").textContent = scenario.summary

  const chips = [
    `Backend: ${flow.backend || "direct"}`,
    `Tools: ${(flow.tools || []).length}`,
    `Checks: ${(flow.probes || []).length}`,
  ]
  $("analysis-meta").innerHTML = chips.map(function(chip) {
    return `<span class="tool-pill">${escapeHtml(chip)}</span>`
  }).join("")
}

function applyPreview(preview) {
  const normalizedFlow = preview.flow === "blocked"
    ? "blocked"
    : `${preview.flow[0].toUpperCase()}${preview.flow.slice(1)}`
  $("stage-title").textContent = preview.flow === "blocked" ? "Preview Blocked" : `${normalizedFlow} Flow`
  $("analysis-flow").textContent = `${normalizedFlow} · ${preview.status || "unknown"}`
  $("analysis-summary").textContent = preview.summary || "No summary available."

  const details = preview.details || {}
  const chips = []
  if (details.intent) chips.push(`Intent: ${details.intent}`)
  if (details.executionMode) chips.push(`Route: ${details.executionMode}`)
  if (details.toolName) chips.push(`Tool: ${details.toolName}`)
  if (details.inferredTool) chips.push(`Tool: ${details.inferredTool}`)
  if (details.governance?.risk) chips.push(`Risk: ${details.governance.risk}`)
  if (!chips.length) chips.push(`Status: ${preview.status || "unknown"}`)
  $("analysis-meta").innerHTML = chips.map(function(chip) {
    return `<span class="tool-pill">${escapeHtml(chip)}</span>`
  }).join("")

  const scenario = SCENARIOS[activeScenarioKey]
  const intro = scenario
    ? [{ role: "user", label: "Preview Input", text: $("scenario-input").value || scenario.prompt }]
    : []
  const resultMessage = {
    role: preview.status === "fail" ? "system" : "live",
    label: "Server Preview",
    text: preview.summary || "Preview complete.",
  }
  renderMessages(intro.concat(resultMessage))
  renderTimeline((preview.steps || []).map(function(step) {
    return {
      title: step.label,
      detail: `${step.status.toUpperCase()} · ${step.detail}`,
    }
  }))
}

async function requestPreview(rawInput) {
  try {
    const response = await fetch("/demo/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: rawInput }),
    })
    const preview = await response.json()
    applyPreview(preview)
  } catch (error) {
    applyPreview({
      flow: "blocked",
      status: "fail",
      summary: `Preview request failed: ${error.message || "unknown error"}`,
      steps: [{ label: "Preview", status: "fail", detail: "Server preview is unavailable." }],
      details: {},
    })
  }
}

function renderFlowCards(meta) {
  const container = $("flow-grid")
  const order = ["customer", "admin", "agent"]
  container.innerHTML = order.map(function(flowName) {
    const flow = meta?.flows?.[flowName] || {}
    const title = `${flowName[0].toUpperCase()}${flowName.slice(1)} Flow`
    const probes = (flow.probes || []).slice(0, 4)
    const toolPreview = (flow.tools || []).slice(0, 4).map(function(tool) {
      return tool.name
    }).join(", ") || "No tools resolved."
    const body = flowName === "customer"
      ? "Customer interactions are constrained by domain policy, allowed intents, manifest bindings, and customer flow execution strategy."
      : flowName === "admin"
        ? "Admin interactions pass access gates first, then route through governance before tools or backend actions can execute."
        : "Agent interactions are the strongest action surface, but governance and approvals still control each step."
    return `<article class="flow-card">
      <header>
        <div>
          <p class="eyebrow">Live Runtime</p>
          <h3>${escapeHtml(title)}</h3>
        </div>
        <span class="status-pill ${statusClass(flow.status)}">${escapeHtml(flow.status || "unknown")}</span>
      </header>
      <p>${escapeHtml(body)}</p>
      <div class="analysis-meta">
        <span class="tool-pill">${escapeHtml(`Backend: ${flow.backend || "direct"}`)}</span>
        <span class="tool-pill">${escapeHtml(`Tools: ${(flow.tools || []).length}`)}</span>
      </div>
      <p><strong>Effective tools:</strong> ${escapeHtml(toolPreview)}</p>
      <ul>
        ${probes.map(function(probe) {
          return `<li class="probe-item">
            <strong>${escapeHtml(probe.name || "probe")}</strong>
            ${escapeHtml(probe.detail || "")}
          </li>`
        }).join("")}
      </ul>
    </article>`
  }).join("")
}

function runScenario(scenarioKey) {
  activeScenarioKey = scenarioKey
  const scenario = SCENARIOS[scenarioKey]
  $("scenario-input").value = scenario.prompt
  $("stage-title").textContent = `${scenario.flow[0].toUpperCase()}${scenario.flow.slice(1)} Flow`
  updateScenarioButtons(scenarioKey)
  renderMessages(scenario.messages)
  renderTimeline(scenario.timeline)
  renderAnalysis(scenarioKey)
  requestPreview(scenario.prompt)
}

async function loadRuntime() {
  if (runtimeMeta) {
    renderRuntimeStrip(runtimeMeta)
    renderFlowCards(runtimeMeta)
    renderAnalysis(activeScenarioKey)
  }
  try {
    const response = await fetch("/demo/meta")
    const meta = await response.json()
    runtimeMeta = meta
    renderRuntimeStrip(meta)
    renderFlowCards(meta)
    renderAnalysis(activeScenarioKey)
  } catch (error) {
    if ($("hero-lede-inline")) $("hero-lede-inline").textContent = "Live runtime snapshot is unavailable right now."
    $("runtime-health").textContent = "Unavailable"
    $("flow-grid").innerHTML = `<article class="flow-card"><h3>Runtime snapshot unavailable</h3><p>${escapeHtml(error.message || "Unknown error")}</p></article>`
  }
}

function setupEvents() {
  document.querySelectorAll("[data-scenario]").forEach(function(button) {
    button.addEventListener("click", function() {
      runScenario(button.getAttribute("data-scenario"))
    })
  })

  $("run-scenario").addEventListener("click", function() {
    const typed = $("scenario-input").value
    activeScenarioKey = inferScenarioFromInput(typed)
    requestPreview(typed)
  })

  $("cycle-scenarios").addEventListener("click", function() {
    const keys = Object.keys(SCENARIOS)
    cycleIndex = (cycleIndex + 1) % keys.length
    runScenario(keys[cycleIndex])
  })

  $("scenario-input").addEventListener("keydown", function(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      $("run-scenario").click()
    }
  })

  $("refresh-runtime").addEventListener("click", loadRuntime)
}

setupEvents()
runScenario(activeScenarioKey)
loadRuntime()
