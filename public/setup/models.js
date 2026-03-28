/* global fetch */
"use strict"

var _flowConfigs = {};
var _availableTools = [];
var _providers = ["openai", "anthropic", "ollama", "mlx", "backend"];
var _backendOnly = ["openclaw", "myclaw", "nemoclaw"];
var _currentFlow = "customer";
var _customerBackendPresets = [];

function $(id) { return document.getElementById(id) }

function ensureFlow(flow) {
  if (!_flowConfigs[flow]) _flowConfigs[flow] = { llm: {}, backend: "direct", tools: [], auth: {}, execution: {}, backend_config: {} };
  if (!_flowConfigs[flow].llm) _flowConfigs[flow].llm = {};
  if (!_flowConfigs[flow].auth) _flowConfigs[flow].auth = {};
  if (!_flowConfigs[flow].execution) _flowConfigs[flow].execution = {};
  if (!_flowConfigs[flow].backend_config) _flowConfigs[flow].backend_config = {};
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
  var backendEndpointEl = $("backend-endpoint-" + flow);
  var backendCommandEl = $("backend-command-" + flow);
  var backendTimeoutEl = $("backend-timeout-" + flow);
  var keywordEl = $("keyword-" + flow);
  var pinEl = $("pin-" + flow);
  var allowedNumbersEl = $("allowed-numbers-" + flow);
  var strategyEl = $("execution-strategy-" + flow);
  var toolIntentsEl = $("tool-intents-" + flow);
  var backendIntentsEl = $("backend-intents-" + flow);
  var capabilityConversationalEl = $("capability-conversational-" + flow);
  var capabilityStructuredEl = $("capability-structured-" + flow);
  var capabilityMemoryEl = $("capability-memory-" + flow);
  var capabilityHandoffsEl = $("capability-handoffs-" + flow);
  var capabilityStructuredOutputEl = $("capability-structured-output-" + flow);
  var responseMaxCharsEl = $("response-max-chars-" + flow);
  var responseStripMarkdownEl = $("response-strip-markdown-" + flow);
  var responsePatternsEl = $("response-patterns-" + flow);

  if (backendEl) cfg.backend = backendEl.value || cfg.backend || "direct";
  if (providerEl && !providerEl.disabled) cfg.llm.provider = providerEl.value || "";
  if (modelEl && !modelEl.disabled) cfg.llm.model = modelEl.value || "";
  if (apiKeyEl && !apiKeyEl.disabled) cfg.llm.api_key = apiKeyEl.value || "";
  if (baseUrlEl && !baseUrlEl.disabled) cfg.llm.base_url = baseUrlEl.value || "";
  if (backendEndpointEl) cfg.endpoint = backendEndpointEl.value || "";
  if (!cfg.backend_config) cfg.backend_config = {};
  if (backendCommandEl) cfg.backend_config.command = backendCommandEl.value || "";
  if (backendTimeoutEl) cfg.backend_config.timeout = parseInt(backendTimeoutEl.value || "90", 10);
  if (strategyEl) cfg.execution.strategy = strategyEl.value || "auto";
  if (toolIntentsEl) {
    cfg.execution.tool_intents = toolIntentsEl.value
      .split(/[\n,]/)
      .map(function(v) { return v.trim(); })
      .filter(Boolean);
  }
  if (backendIntentsEl) {
    cfg.execution.backend_intents = backendIntentsEl.value
      .split(/[\n,]/)
      .map(function(v) { return v.trim(); })
      .filter(Boolean);
  }
  if (!cfg.execution.backend_capabilities) cfg.execution.backend_capabilities = {};
  if (capabilityConversationalEl) cfg.execution.backend_capabilities.conversational = !!capabilityConversationalEl.checked;
  if (capabilityStructuredEl) cfg.execution.backend_capabilities.structured = !!capabilityStructuredEl.checked;
  if (capabilityMemoryEl) cfg.execution.backend_capabilities.memory = !!capabilityMemoryEl.checked;
  if (capabilityHandoffsEl) cfg.execution.backend_capabilities.handoffs = !!capabilityHandoffsEl.checked;
  if (capabilityStructuredOutputEl) cfg.execution.backend_capabilities.structured_output = !!capabilityStructuredOutputEl.checked;
  if (!cfg.execution.response_policy) cfg.execution.response_policy = {};
  if (responseMaxCharsEl) cfg.execution.response_policy.max_chars = parseInt(responseMaxCharsEl.value || "1200", 10);
  if (responseStripMarkdownEl) cfg.execution.response_policy.strip_markdown = !!responseStripMarkdownEl.checked;
  if (responsePatternsEl) {
    cfg.execution.response_policy.disallow_patterns = responsePatternsEl.value
      .split(/[\n,]/)
      .map(function(v) { return v.trim(); })
      .filter(Boolean);
  }
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
    _customerBackendPresets = d.customerBackendPresets || [];
    renderFlowEditor();
    loadCustomerObservability();
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
  var execution = cfg.execution || {};
  var backendCapabilities = execution.backend_capabilities || {};
  var responsePolicy = execution.response_policy || {};
  var backendConfig = cfg.backend_config || {};
  
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
    ${flowName === 'customer' ? `
    <div style="margin-bottom:12px; padding:12px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--surface-2)">
      <div style="display:flex; gap:10px; align-items:end; margin-bottom:12px; flex-wrap:wrap;">
        <label class="field" style="flex:1; min-width:220px;"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">Preset</span>
          <select id="customer-backend-preset" style="margin-top: 4px;">
            <option value="">Custom / keep current</option>
            ${_customerBackendPresets.map(function(p) { return `<option value="${p.id}">${p.name}</option>` }).join("")}
          </select>
        </label>
        <button class="btn btn-ghost btn-sm" onclick="applyCustomerPreset()">Apply Preset</button>
      </div>
      <div style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase; margin-bottom:8px;">Customer Execution Strategy</div>
      <label class="field"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">Strategy</span>
        <select id="execution-strategy-${flowName}" onchange="syncCurrentFlowFromInputs()" style="margin-top: 4px;">
          <option value="auto" ${(execution.strategy || "auto") === 'auto' ? 'selected' : ''}>Auto</option>
          <option value="tool_first" ${execution.strategy === 'tool_first' ? 'selected' : ''}>Tool First</option>
          <option value="backend_first" ${execution.strategy === 'backend_first' ? 'selected' : ''}>Backend First</option>
          <option value="hybrid" ${execution.strategy === 'hybrid' ? 'selected' : ''}>Hybrid</option>
        </select>
      </label>
      <div style="margin-top:6px;font-size:0.78rem;color:var(--muted)">
        Auto keeps structured intents on tools and conversational requests on the backend. Tool First prefers manifest tools. Backend First prefers the configured backend. Hybrid uses explicit intent overrides first, then falls back to Auto.
      </div>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top:12px;">
        <label class="field"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">Always Use Tools For</span>
          <textarea id="tool-intents-${flowName}" oninput="syncCurrentFlowFromInputs()" style="margin-top: 4px; min-height: 72px;" placeholder="support, place_order">${(execution.tool_intents || []).join("\n")}</textarea>
        </label>
        <label class="field"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">Always Use Backend For</span>
          <textarea id="backend-intents-${flowName}" oninput="syncCurrentFlowFromInputs()" style="margin-top: 4px; min-height: 72px;" placeholder="general_chat, greet">${(execution.backend_intents || []).join("\n")}</textarea>
        </label>
      </div>
      <div style="margin-top:12px; font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">Backend Capabilities</div>
      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap:8px; margin-top:8px;">
        <label style="display:flex; align-items:center; gap:8px; font-size:0.82rem; cursor:pointer"><input id="capability-conversational-${flowName}" type="checkbox" onchange="syncCurrentFlowFromInputs()" ${backendCapabilities.conversational !== false ? 'checked' : ''}> Conversational</label>
        <label style="display:flex; align-items:center; gap:8px; font-size:0.82rem; cursor:pointer"><input id="capability-structured-${flowName}" type="checkbox" onchange="syncCurrentFlowFromInputs()" ${backendCapabilities.structured ? 'checked' : ''}> Structured intents</label>
        <label style="display:flex; align-items:center; gap:8px; font-size:0.82rem; cursor:pointer"><input id="capability-memory-${flowName}" type="checkbox" onchange="syncCurrentFlowFromInputs()" ${backendCapabilities.memory ? 'checked' : ''}> Memory</label>
        <label style="display:flex; align-items:center; gap:8px; font-size:0.82rem; cursor:pointer"><input id="capability-handoffs-${flowName}" type="checkbox" onchange="syncCurrentFlowFromInputs()" ${backendCapabilities.handoffs ? 'checked' : ''}> Handoffs</label>
        <label style="display:flex; align-items:center; gap:8px; font-size:0.82rem; cursor:pointer"><input id="capability-structured-output-${flowName}" type="checkbox" onchange="syncCurrentFlowFromInputs()" ${backendCapabilities.structured_output ? 'checked' : ''}> Structured output</label>
      </div>
      <div style="margin-top:12px; font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">Backend Response Guard</div>
      <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px; margin-top:8px;">
        <label class="field"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">Max Characters</span>
          <input type="number" id="response-max-chars-${flowName}" value="${responsePolicy.max_chars || 1200}" min="80" max="4000" oninput="syncCurrentFlowFromInputs()" style="margin-top: 4px;">
        </label>
        <label style="display:flex; align-items:center; gap:8px; font-size:0.82rem; cursor:pointer; margin-top: 24px;"><input id="response-strip-markdown-${flowName}" type="checkbox" onchange="syncCurrentFlowFromInputs()" ${responsePolicy.strip_markdown ? 'checked' : ''}> Strip markdown before validation</label>
        <label class="field" style="grid-column: 1 / -1"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">Disallowed Backend Response Patterns</span>
          <textarea id="response-patterns-${flowName}" oninput="syncCurrentFlowFromInputs()" style="margin-top: 4px; min-height: 72px;" placeholder="internal policy, system prompt">${(responsePolicy.disallow_patterns || []).join("\n")}</textarea>
        </label>
      </div>
    </div>
    ` : ''}
    ${mode === 'backend' ? `
    <div style="margin:0 0 12px; padding:12px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--surface-2)">
      <div style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase; margin-bottom:8px;">Backend Service Configuration</div>
      <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 14px;">
        <label class="field"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">Backend Endpoint</span>
          <input type="text" id="backend-endpoint-${flowName}" value="${cfg.endpoint || llm.endpoint || llm.base_url || ''}" oninput="syncCurrentFlowFromInputs()" placeholder="Optional: remote backend URL" style="margin-top: 4px;">
        </label>
        <label class="field"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">CLI Command</span>
          <input type="text" id="backend-command-${flowName}" value="${backendConfig.command || 'openclaw'}" oninput="syncCurrentFlowFromInputs()" placeholder="openclaw" style="margin-top: 4px;">
        </label>
        <label class="field"><span style="font-size: 0.75rem; color: var(--muted); text-transform: uppercase;">Timeout (seconds)</span>
          <input type="number" id="backend-timeout-${flowName}" value="${backendConfig.timeout || 90}" min="10" max="600" oninput="syncCurrentFlowFromInputs()" style="margin-top: 4px;">
        </label>
      </div>
      <div style="margin-top:6px;font-size:0.78rem;color:var(--muted)">
        For OpenClaw/MyClaw/NemoClaw, the runtime currently executes the local CLI command. Set the command here if the binary name or path is different on this machine.
      </div>
    </div>
    ` : ''}
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

async function applyCustomerPreset() {
  var select = $("customer-backend-preset");
  if (!select || !select.value) return;
  try {
    var d = await api("/agent-config/customer-presets/" + encodeURIComponent(select.value));
    var preset = d.preset;
    if (!preset) return;
    var cfg = ensureFlow("customer");
    cfg.execution = JSON.parse(JSON.stringify(preset.execution || {}));
    if (preset.id) cfg.backend = preset.id;
    renderFlowEditor();
  } catch (e) {
    alert("Preset load failed: " + e.message);
  }
}

async function loadCustomerObservability() {
  var el = $("customer-observability");
  if (!el) return;
  try {
    var d = await api("/setup/customer/observability?limit=100");
    var s = d.summary || {};
    var routeRows = Object.entries(s.byRoute || {}).map(function(entry) {
      return `<div><strong>${entry[0]}</strong>: ${entry[1]}</div>`;
    }).join("") || "<div>No recent route data.</div>";
    var strategyRows = Object.entries(s.byStrategy || {}).map(function(entry) {
      return `<div><strong>${entry[0]}</strong>: ${entry[1]}</div>`;
    }).join("") || "<div>No recent strategy data.</div>";
    var recentRows = (s.recent || []).slice(0, 8).map(function(item) {
      return `<div style="padding:8px 0;border-top:1px solid var(--border);font-size:0.8rem">
        <div><strong>${item.route}</strong> · ${item.strategy || "unknown"} ${item.backend ? "· " + item.backend : ""}</div>
        <div style="color:var(--muted)">${item.reason || "no reason"}${item.guardIssues && item.guardIssues.length ? " · guard: " + item.guardIssues.join(", ") : ""}</div>
      </div>`;
    }).join("") || "<div>No recent customer interactions logged yet.</div>";

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div>
          <div style="font-size:0.78rem;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Summary</div>
          <div><strong>Total:</strong> ${s.total || 0}</div>
          <div><strong>Policy blocks:</strong> ${s.policyBlocks || 0}</div>
          <div><strong>Backend guard hits:</strong> ${s.backendGuardHits || 0}</div>
          <div style="margin-top:10px">${routeRows}</div>
        </div>
        <div>
          <div style="font-size:0.78rem;color:var(--muted);text-transform:uppercase;margin-bottom:8px">By Strategy</div>
          <div>${strategyRows}</div>
        </div>
      </div>
      <div style="margin-top:14px">
        <div style="font-size:0.78rem;color:var(--muted);text-transform:uppercase;margin-bottom:8px">Recent Customer Runtime Signals</div>
        ${recentRows}
      </div>
    `;
  } catch (e) {
    el.innerHTML = `<div style="color:var(--muted);font-size:0.82rem">Observability unavailable: ${e.message}</div>`;
  }
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
