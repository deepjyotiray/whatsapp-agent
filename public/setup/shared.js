/* ── SecureAI Shared Module ───────────────────────────────────────────────── */
"use strict"

let activeWorkspace = "default"

async function api(url, method = "GET", body) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401) { window.location.href = "/login"; throw new Error("Unauthorized") }
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function ws(url) {
  const j = url.includes("?") ? "&" : "?"
  return `${url}${j}workspace=${encodeURIComponent(activeWorkspace)}`
}

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML }

function $(id) { return document.getElementById(id) }

function show(id) { $(id)?.classList.remove("hidden") }
function hide(id) { $(id)?.classList.add("hidden") }

function setText(id, t) { const e = $(id); if (e) e.textContent = t }

// ── Sidebar + Topbar ─────────────────────────────────────────────────────────

const NAV = [
  { group: "Workspace", items: [
    { id: "dashboard", icon: "▣", label: "Dashboard", href: "/" },
    { id: "profile", icon: "◐", label: "Profile", href: "/profile" },
    { id: "chat", icon: "◑", label: "Chat", href: "/chat" },
  ]},
  { group: "Agent Management", items: [
    { id: "admin", icon: "⚙", label: "Admin", href: "/admin" },
    { id: "tools", icon: "⬡", label: "Agent Tools", href: "/tools" },
    { id: "intercept", icon: "◇", label: "Interceptor", href: "/intercept" },
    { id: "control", icon: "▣", label: "Control Panel", href: "/control" },
    { id: "models", icon: "◈", label: "Models", href: "/models" },
  ]},
]

function buildShell(pageId) {
  // topbar
  const topbar = document.createElement("header")
  topbar.className = "topbar"
  topbar.innerHTML = `
    <div class="topbar-left">
      <span class="logo">SecureAI</span>
      <h1 id="topbar-title"></h1>
    </div>
    <div class="topbar-right">
      <span class="ws-label">Workspace</span>
      <select id="ws-select"></select>
      <button class="btn btn-ghost btn-sm" id="logout-btn">Log Out</button>
    </div>`
  document.body.prepend(topbar)

  // sidebar
  const sidebar = document.createElement("nav")
  sidebar.className = "sidebar"
  let html = ""
  for (const g of NAV) {
    html += `<div class="nav-group"><div class="nav-group-label">${g.group}</div>`
    for (const item of g.items) {
      const cls = item.id === pageId ? "nav-item active" : "nav-item"
      html += `<a class="${cls}" href="${item.href}"><span class="nav-icon">${item.icon}</span>${item.label}</a>`
    }
    html += `</div>`
  }
  sidebar.innerHTML = html
  document.body.insertBefore(sidebar, topbar.nextSibling)

  // logout
  $("logout-btn").addEventListener("click", async () => {
    await api("/setup/logout", "POST", {})
    window.location.href = "/login"
  })
}

async function initWorkspace() {
  try {
    const data = await api("/setup/workspaces")
    const sel = $("ws-select")
    sel.innerHTML = ""
    for (const id of data.workspaces || []) {
      const opt = document.createElement("option")
      opt.value = id
      opt.textContent = id
      if (id === data.active) opt.selected = true
      sel.appendChild(opt)
    }
    activeWorkspace = data.active || (data.workspaces?.[0]) || "default"
    sel.addEventListener("change", async () => {
      const res = await api("/setup/workspace/select", "POST", { workspaceId: sel.value })
      activeWorkspace = res.activeWorkspace || sel.value
      if (typeof onWorkspaceChange === "function") onWorkspaceChange()
    })
  } catch (e) { console.error("[workspace]", e) }
}
