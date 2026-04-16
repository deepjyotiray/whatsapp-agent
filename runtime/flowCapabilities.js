"use strict"

const fs = require("fs")
const path = require("path")
const agentChain = require("./agentChain")
const executor = require("./executor")
const { normalizeCustomerExecutionConfig } = require("./customerExecutionConfig")
const { decideCustomerExecution } = require("./flowOrchestrator")
const { getGovernanceSnapshot } = require("../gateway/adminGovernance")
const { getAllowedToolsForFlow, getFlowAccessConfig } = require("../gateway/admin")
const { resolveToolDefinitions, getFilteredOpenClawTools } = require("../gateway/adminAgent")
const { loadProfile } = require("../setup/profileService")
const { getPackForWorkspace } = require("../core/domainPacks")

const SETTINGS_PATH = path.resolve(__dirname, "../config/settings.json")

function loadSettings() {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"))
}

function summarizeProbe(name, ok, detail, severity = "error") {
    return { name, ok: !!ok, severity, detail: detail || "" }
}

const FLOW_TOOL_ALIASES = {
    shell: "run_shell",
    db: "query_db",
    sql: "query_db",
    skill_call: "run_skill",
}

function normalizeFlowToolName(name = "") {
    return FLOW_TOOL_ALIASES[name] || name
}

function isDirectOnlyFlowCapability(name = "") {
    return name === "approvals"
}

function summarizeStatus(probes = []) {
    if (!probes.length) return "unknown"
    if (probes.some(probe => !probe.ok && probe.severity === "error")) return "fail"
    if (probes.some(probe => !probe.ok)) return "warn"
    return "pass"
}

function resolveStructuralGovernance(toolName, snapshot, worker = "operator") {
    const role = snapshot.role
    const toolPolicy = snapshot.tools?.[toolName] || null
    const workerTools = snapshot.workers?.[worker] || []
    if (!toolPolicy) {
        return { allowed: false, reason: "missing_governance_policy", role, worker }
    }
    if (workerTools.length && !workerTools.includes(toolName) && role !== "system_admin") {
        return { allowed: false, reason: "worker_blocked", role, worker }
    }
    if (Array.isArray(toolPolicy.roles) && !toolPolicy.roles.includes(role)) {
        return { allowed: false, reason: "role_blocked", role, worker }
    }
    return {
        allowed: true,
        reason: "allowed",
        role,
        worker,
        risk: toolPolicy.risk,
        category: toolPolicy.category,
        approval: toolPolicy.approval,
        mutating: !!toolPolicy.mutating,
    }
}

function getCustomerIntentRouting(flowConfig, manifest) {
    return Object.keys(manifest?.intents || {}).map(intentName => ({
        intent: intentName,
        ...decideCustomerExecution({
            flowConfig,
            routedIntent: { intent: intentName, filter: {} },
            manifest,
        }),
    }))
}

function getCustomerSnapshot(settings, workspaceId) {
    const manifest = agentChain._manifest
    const flowConfig = {
        ...(settings.flows?.customer || {}),
        backend: settings.flows?.customer?.backend || settings.customer?.backend || "direct",
        execution: normalizeCustomerExecutionConfig(settings.flows?.customer?.execution || {}),
    }
    const tools = (agentChain.getTools() || []).map(tool => {
        const handler = executor.resolveToolHandler(tool.type)
        return {
            name: tool.name,
            type: tool.type,
            handlerReady: !!handler,
            source: manifest?.tools?.[tool.name] ? "manifest" : "unknown",
        }
    })
    const intents = agentChain.getIntents().map(intent => ({
        ...intent,
        toolDefined: !!manifest?.tools?.[intent.tool],
    }))
    const probes = [
        summarizeProbe("manifest_loaded", !!manifest, manifest?.agent?.name || "No manifest loaded."),
        summarizeProbe(
            "tool_handlers_resolve",
            tools.every(tool => tool.handlerReady),
            tools.filter(tool => !tool.handlerReady).map(tool => `${tool.name}:${tool.type}`).join(", ") || "All customer tools resolve to handlers."
        ),
        summarizeProbe(
            "intent_bindings_valid",
            intents.every(intent => intent.toolDefined),
            intents.filter(intent => !intent.toolDefined).map(intent => `${intent.name}->${intent.tool}`).join(", ") || "All intents point to manifest tools."
        ),
        summarizeProbe(
            "backend_config_present",
            flowConfig.backend === "direct" || !!(settings.flows?.customer?.backend_config?.command || settings.flows?.customer?.endpoint),
            flowConfig.backend === "direct"
                ? "Customer flow uses direct tool mode."
                : `Backend ${flowConfig.backend} is configured via command or endpoint.`
        ),
    ]

    return {
        flow: "customer",
        status: summarizeStatus(probes),
        backend: flowConfig.backend || "direct",
        auth: getFlowAccessConfig("customer"),
        execution: flowConfig.execution,
        tools,
        intents,
        routing: getCustomerIntentRouting(flowConfig, manifest),
        probes,
        truthSources: [
            "loaded manifest",
            "registered tool handlers",
            "customer execution config",
        ],
        workspaceId,
    }
}

function getAdminLikeSnapshot(flow, settings, workspaceId, governance) {
    const flowCfg = settings.flows?.[flow] || {}
    const backend = flowCfg.backend || (flow === "agent" ? settings.admin?.agent_backend || "openclaw" : settings.admin?.backend || "direct")
    const directTools = getAllowedToolsForFlow(flow)
    const openClawTools = getFilteredOpenClawTools(workspaceId, flow, settings).map(tool => tool.function.name)
    const resolvedTools = resolveToolDefinitions(workspaceId).map(tool => tool.function.name)
    const effectiveToolNames = Array.from(new Set((backend && backend !== "direct" ? openClawTools : resolvedTools)))
    const effectiveTools = effectiveToolNames.map(name => ({
        name,
        governance: resolveStructuralGovernance(name, governance, "operator"),
    }))

    const probes = [
        summarizeProbe(
            "effective_toolset_present",
            effectiveTools.length > 0,
            effectiveTools.length ? `${effectiveTools.length} tools available.` : "No effective tools resolved for this flow."
        ),
        summarizeProbe(
            "direct_allowlist_matches_runtime",
            directTools.every(name => {
                if (isDirectOnlyFlowCapability(name)) return true
                const normalized = normalizeFlowToolName(name)
                return resolvedTools.includes(normalized) || openClawTools.includes(normalized)
            }),
            directTools.filter(name => {
                if (isDirectOnlyFlowCapability(name)) return false
                const normalized = normalizeFlowToolName(name)
                return !resolvedTools.includes(normalized) && !openClawTools.includes(normalized)
            }).join(", ") || "Configured allowlist maps to known runtime tools.",
            "warn"
        ),
        summarizeProbe(
            "governance_covers_effective_tools",
            effectiveTools.every(tool => tool.governance.allowed),
            effectiveTools.filter(tool => !tool.governance.allowed).map(tool => `${tool.name}:${tool.governance.reason}`).join(", ") || "Governance allows the current effective toolset."
        ),
        summarizeProbe(
            "backend_path_configured",
            backend === "direct" || !!(flowCfg.backend_config?.command || flowCfg.endpoint),
            backend === "direct"
                ? `${flow} flow uses direct execution.`
                : `${flow} flow backend ${backend} is configured via command or endpoint.`
        ),
    ]

    return {
        flow,
        status: summarizeStatus(probes),
        backend,
        auth: getFlowAccessConfig(flow),
        directAllowlist: directTools,
        runtimeTools: effectiveTools,
        toolCatalog: {
            direct: resolvedTools,
            backendScoped: openClawTools,
        },
        probes,
        truthSources: [
            "admin/agent tool definitions",
            "flow allowlists",
            "governance policy",
            "backend-specific tool filtering",
        ],
        workspaceId,
    }
}

function buildFlowCapabilitiesSnapshot(workspaceId) {
    const settings = loadSettings()
    const governance = getGovernanceSnapshot(settings.admin?.role, workspaceId)
    let profile = {}
    let pack = null
    try {
        profile = loadProfile(workspaceId)
        pack = getPackForWorkspace(profile)
    } catch {}

    const health = agentChain.healthCheck()
    const customer = health.status === "ok"
        ? getCustomerSnapshot(settings, workspaceId)
        : {
            flow: "customer",
            status: "fail",
            probes: [summarizeProbe("agent_loaded", false, "No agent manifest is loaded.")],
            tools: [],
            intents: [],
            routing: [],
            backend: settings.flows?.customer?.backend || settings.customer?.backend || "direct",
            auth: getFlowAccessConfig("customer"),
            truthSources: ["agent health"],
            workspaceId,
        }

    const admin = getAdminLikeSnapshot("admin", settings, workspaceId, governance)
    const agent = getAdminLikeSnapshot("agent", settings, workspaceId, governance)

    return {
        generatedAt: new Date().toISOString(),
        workspaceId,
        health,
        profile: {
            businessName: profile.businessName || "",
            domainPack: profile.domainPack || "",
            dbPath: profile.dbPath || "",
        },
        domainPack: pack ? {
            name: pack.name,
            domain: pack.domain,
            version: pack.version || "",
            customerToolTypes: Object.keys(pack.toolTypes || {}),
            adminTools: (pack.adminToolDefinitions || []).map(tool => tool.function?.name).filter(Boolean),
        } : null,
        flows: {
            customer,
            admin,
            agent,
        },
    }
}

module.exports = {
    buildFlowCapabilitiesSnapshot,
}
