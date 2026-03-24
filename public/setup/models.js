/* global fetch */
"use strict"

var _flowConfigs = {};
var _availableTools = [];
var _providers = ["openai", "anthropic", "ollama", "mlx", "backend"];
var _backendOnly = ["openclaw", "myclaw", "nemoclaw"];
var _currentFlow = "customer";

function $(id) { return document.getElementById(id) }

function ensureFlow(flow) {
  if (!_flowConfigs[flow]) _flowConfigs[flow] = { llm: {}, backend: "direct", tools: [], auth: {} };
  if (!_flowConfigs[flow].llm) _flowConfigs[flow].llm = {};
  if (!_flowConfigs[flow].auth) _flowConfigs[flow].auth = {};
  return _flowConfigs[flow];
}

function resolveMode(cfg) {
  return (cfg.backend && cfg.backend !== "direct") ? "backend" : "llm";
}

function setFlowMode(flow, mode) {
  var cfg = ensureFlow(flow);
  if (mode === "llm") {
    cfg.backend = "direct";
  } else {
    if (!cfg.backend || cfg.backend === "direct") cfg.backend = _backendOnly[0];
  }
}

function syncCurrentFlowFromInputs() {
  var flow = _currentFlow;
  var cfg = ensureFlow(flow);

  var modeEl = $("mode-" + flow);
  if (modeEl) setFlowMode(flow, modeEl.value);

  var providerEl = $("provider-" + flow);
  var modelEl = $("model-" + flow);
  var backendEl = $("backend-" + flow);
  var apiKeyEl = $("api-key-" + flow);
  var baseUrlEl = $("base-url-" + flow);
  var keywordEl = $("keyword-" + flow);
  var pinEl = $("pin-" + flow);
  var allowedNumbersEl = $("allowed-numbers-" + flow);

  if (backendEl) cfg.backend = backendEl.value || cfg.backend || "direct";
  if (providerEl && !providerEl.disabled) cfg.llm.provider = providerEl.value || "";
  if (modelEl && !modelEl.disabled) cfg.llm.model = modelEl.value || "";
  if (apiKeyEl && !apiKeyEl.disabled) cfg.llm.api_key = apiKeyEl.value || "";
  if (baseUrlEl && !baseUrlEl.disabled) cfg.llm.base_url = baseUrlEl.value || "";
  if (keywordEl) cfg.auth.keyword = keywordEl.value || "";
  if (pinEl) cfg.auth.pin = pinEl.value || "";
  if (allowedNumbersEl) {
    cfg.auth.allowed_numbers = allowedNumbersEl.value
      .split(/[\n,]/)
      .map(function(v) { return v.trim(); })
      .filter(Boolean);
  }

  if (flow !== "customer") {
    var checks = Array.from(document.querySelectorAll("#flow-config-editor input[type=checkbox][value]"));
    cfg.tools = checks.filter(c => c.checked).map(c => c.value);
  }
}

async function loadFlowConfigs() {
  try {
    var d = await api("/agent-config");
    _flowConfigs = d.flows || {};
    _availableTools = d.availableTools || [];
    renderFlowEditor();
  } catch (e) { console.error(e); }
}

function switchFlow(name) {
  syncCurrentFlowFromInputs();
  _currentFlow = name;
  renderFlowEditor();
}

function renderFlowEditor() {
  var container = $("flow-config-editor");
  if (!container) return;
  var flowName = _currentFlow;
  var cfg = _flowConfigs[flowName] || { llm: {}, backend: "", tools: [] };
  var llm = cfg.llm || {};
  var auth = cfg.auth || {};
  
  // Ensure backend has a default if missing entirely
  var backend = cfg.backend || "direct";
  var mode = resolveMode({ backend: backend });
  var llmDisabled = mode === "backend";
  var backendOptions = llmDisabled ? _backendOnly : ["direct"];
  
  var html = `
    <div style="margin-bottom:12px">
      <label class="field"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">Mode</span>
        <select id="mode-${flowName}" onchange="setFlowMode('${flowName}', this.value); renderFlowEditor()" style="margin-top: 4px;">
          <option value="llm" ${mode === 'llm' ? 'selected' : ''}>LLM (Direct API)</option>
          <option value="backend" ${mode === 'backend' ? 'selected' : ''}>Backend Service</option>
        </select>
      </label>
      <div style="margin-top:6px;font-size:0.78rem;color:var(--muted)">
        ${llmDisabled
          ? "Backend mode routes requests to a service like OpenClaw/MyClaw/NemoClaw. LLM provider and model are disabled."
          : "LLM mode talks directly to the selected provider. Backend is fixed to Direct LLM."}
      </div>
    </div>
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px;">
      ${flowName === 'customer' ? '' : `
      <label class="field"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">Hotword</span>
        <input type="text" id="keyword-${flowName}" value="${auth.keyword || ''}" oninput="updateFlowConfig('${flowName}', 'auth.keyword', this.value)" style="margin-top: 4px;" placeholder="${flowName}">
      </label>
      <label class="field"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">PIN</span>
        <input type="text" id="pin-${flowName}" value="${auth.pin || ''}" oninput="updateFlowConfig('${flowName}', 'auth.pin', this.value)" style="margin-top: 4px;" placeholder="4-6 digits">
      </label>
      <label class="field" style="grid-column: 1 / -1"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">Allowed Numbers</span>
        <textarea id="allowed-numbers-${flowName}" oninput="syncCurrentFlowFromInputs()" style="margin-top: 4px; min-height: 86px;" placeholder="One number per line or comma-separated">${(auth.allowed_numbers || []).join("\n")}</textarea>
        <div style="margin-top:6px;font-size:0.78rem;color:var(--muted)">
          Only messages from these numbers can enter the ${flowName} flow when the matching hotword and PIN are used.
        </div>
      </label>
      `} 
      <label class="field"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">LLM Provider</span>
        <select id="provider-${flowName}" onchange="updateFlowProvider('${flowName}', this.value)" style="margin-top: 4px;" ${llmDisabled ? "disabled" : ""}>
          ${_providers.map(p => `<option value="${p}" ${llm.provider === p ? 'selected' : ''}>${p}</option>`).join("")}
        </select>
      </label>
      <label class="field"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">LLM Model</span>
        <div style="display:flex;gap:4px; margin-top: 4px;">
          <input type="text" id="model-${flowName}" value="${llm.model || ''}" oninput="updateFlowConfig('${flowName}', 'llm.model', this.value)" style="flex:1" placeholder="e.g. gpt-4o" ${llmDisabled ? "disabled" : ""}>
          <button class="btn btn-ghost btn-sm" onclick="discoverModels('${flowName}')" title="Discover Models" ${llmDisabled ? "disabled" : ""}>🔍</button>
        </div>
      </label>
      <label class="field"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">Backend Type</span>
        <select id="backend-${flowName}" onchange="updateFlowConfig('${flowName}', 'backend', this.value)" style="margin-top: 4px;">
          ${backendOptions.map(b => {
            const label = b === "direct" ? "Direct LLM" : (b === "openclaw" ? "OpenClaw Pipeline" : (b === "myclaw" ? "MyClaw" : "NemoClaw"))
            return `<option value="${b}" ${backend === b ? 'selected' : ''}>${label}</option>`
          }).join("")}
        </select>
      </label>
      <label class="field"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">API Key / Secret</span>
        <input type="password" id="api-key-${flowName}" value="${llm.api_key || ''}" oninput="updateFlowConfig('${flowName}', 'llm.api_key', this.value)" placeholder="••••••••" style="margin-top: 4px;" ${llmDisabled ? "disabled" : ""}>
      </label>
      <label class="field" style="grid-column: 1 / -1"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">Base URL / Endpoint</span>
        <input type="text" id="base-url-${flowName}" value="${llm.base_url || llm.url || cfg.endpoint || ''}" oninput="updateFlowConfig('${flowName}', 'llm.base_url', this.value)" placeholder="https://api.openai.com/v1 or http://localhost:11434" style="margin-top: 4px;" ${llmDisabled ? "disabled" : ""}>
      </label>
    </div>

    <div style="margin-top:15px">
      <span style="display:block; font-size:0.75rem; font-weight:600; color:var(--muted); margin-bottom:8px; text-transform:uppercase">Allowed Tools</span>
      ${flowName === 'customer' 
        ? `<p style="font-size:0.8rem; color:var(--muted)">Customer tools are managed in the <a href="/tools" style="color:var(--accent)">Agent Manifest Editor</a>.</p>`
        : `<div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:8px; padding:10px; background:var(--surface-2); border:1px solid var(--border); border-radius:var(--radius-sm); max-height:200px; overflow-y:auto">
            ${_availableTools.map(t => `
              <label style="display:flex; align-items:center; gap:8px; font-size:0.82rem; cursor:pointer">
                <input type="checkbox" value="${t}" ${ (cfg.tools || []).includes(t) ? 'checked' : '' } onchange="toggleFlowTool('${flowName}', '${t}', this.checked)">
                ${t}
              </label>
            `).join("")}
            ${_availableTools.length === 0 ? '<span style="color:var(--muted); font-size:0.8rem">No tools found in manifest.</span>' : ''}
          </div>`
      }
    </div>
  `;
  
  container.innerHTML = html;
}

function updateFlowConfig(flow, path, value) {
  var curr = ensureFlow(flow);
  var parts = path.split('.');
  for (var i = 0; i < parts.length - 1; i++) {
    if (!curr[parts[i]]) curr[parts[i]] = {};
    curr = curr[parts[i]];
  }
  curr[parts[parts.length - 1]] = value;
}

function updateFlowProvider(flow, provider) {
  syncCurrentFlowFromInputs();
  var cfg = ensureFlow(flow);
  cfg.llm.provider = provider;
  renderFlowEditor();
}

function toggleFlowTool(flow, tool, checked) {
  var cfg = ensureFlow(flow);
  if (!Array.isArray(cfg.tools)) cfg.tools = [];
  if (checked) {
    if (!cfg.tools.includes(tool)) cfg.tools.push(tool);
  } else {
    cfg.tools = cfg.tools.filter(t => t !== tool);
  }
}

async function discoverModels(flow) {
  var llm = (_flowConfigs[flow] || {}).llm || {};
  var provider = llm.provider;
  if (!provider) return;
  try {
    var url = "/agent/models/" + provider + "?api_key=" + encodeURIComponent(llm.api_key || "") + "&base_url=" + encodeURIComponent(llm.base_url || llm.url || "");
    var d = await api(url);
    if (d.models && d.models.length) {
      var model = prompt("Select a model:\n" + d.models.join("\n"), d.models[0]);
      if (model) {
        var input = $("model-" + flow);
        if (input) input.value = model;
        updateFlowConfig(flow, 'llm.model', model);
      }
    } else {
      alert("No models discovered for " + provider);
    }
  } catch (e) { alert("Discovery failed: " + e.message); }
}

async function saveCurrentFlowConfig() {
  syncCurrentFlowFromInputs();
  var status = $("flow-save-status");
  status.textContent = "Saving...";
  try {
    await api("/agent-config", "POST", { flows: _flowConfigs });
    status.textContent = "Saved & Sessions Cleared!";
    setTimeout(() => { status.textContent = "" }, 3000);
  } catch (e) {
    status.textContent = "Error: " + e.message;
    console.error(e);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  buildShell("models");
  if (typeof initWorkspace === "function") {
    initWorkspace().then(loadFlowConfigs).catch(loadFlowConfigs);
  } else {
    loadFlowConfigs();
  }
});
