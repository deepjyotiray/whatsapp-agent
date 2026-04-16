"use strict"

const agentChain = require("./agentChain")
const { sanitize } = require("../gateway/sanitizer")
const { heuristicIntent } = require("../gateway/customerRouter")
const { evaluateCustomerPreRoutePolicy, evaluateCustomerResolvedPolicy } = require("./customerPolicy")
const { decideCustomerExecution } = require("./flowOrchestrator")
const { buildResolvedRequest } = require("./resolvedRequest")
const { getFlowAccessConfig } = require("../gateway/admin")
const { authorizeToolCall, getGovernanceSnapshot } = require("../gateway/adminGovernance")
const { loadProfile } = require("../setup/profileService")
const { getPackForWorkspace } = require("../core/domainPacks")

function summarizeStatus(ok, warning = false) {
    if (!ok) return "fail"
    return warning ? "warn" : "pass"
}

function makeStep(label, status, detail) {
    return { label, status, detail }
}

function inferAdminTool(task = "") {
    const text = String(task || "").toLowerCase()
    if (/\bupdate\b.*\border\b|\border\b.*\bupdate\b|\bdelivered\b|\bconfirmed\b/.test(text)) return "update_order"
    if (/\bexpense|income|revenue|profit|month|today|orders?|subscriptions?|users?|deliveries\b/.test(text)) return "query_db"
    if (/\bmessage\b|\bwhatsapp\b|\bsend\b/.test(text)) return "send_whatsapp"
    if (/\blog\b|\bpm2\b|\bserver\b|\buptime\b|\brestart\b/.test(text)) return "run_shell"
    if (/\bhealth\b|\bstatus\b/.test(text)) return "server_health"
    if (/\bopen\b|\bbrowser\b|\bpage\b|\bclick\b/.test(text)) return "open_browser"
    return "query_db"
}

function detectFlow(message, workspaceId) {
    const text = String(message || "").trim()
    const lower = text.toLowerCase()
    const adminAccess = getFlowAccessConfig("admin")
    const agentAccess = getFlowAccessConfig("agent")
    const stripPrefix = (input, keyword) => {
        const parts = String(input || "").trim().split(/\s+/)
        if (!parts.length || parts[0].toLowerCase() !== keyword.toLowerCase()) return input
        if (parts.length > 1 && /^\d{4,8}$/.test(parts[1])) return parts.slice(2).join(" ")
        return parts.slice(1).join(" ")
    }

    if (lower.startsWith(`${agentAccess.keyword.toLowerCase()} `) || lower === agentAccess.keyword.toLowerCase()) {
        return {
            flow: "agent",
            commandText: stripPrefix(text, agentAccess.keyword),
            access: agentAccess,
        }
    }
    if (lower.startsWith(`${adminAccess.keyword.toLowerCase()} `) || lower === adminAccess.keyword.toLowerCase()) {
        return {
            flow: "admin",
            commandText: stripPrefix(text, adminAccess.keyword),
            access: adminAccess,
        }
    }
    return { flow: "customer", commandText: text, access: null, workspaceId }
}

function previewCustomer(message, workspaceId) {
    const manifest = agentChain._manifest
    const profile = loadProfile(workspaceId)
    const pack = getPackForWorkspace(profile)
    const resolvedRequest = buildResolvedRequest({
        flow: "customer",
        originalMessage: message,
        effectiveMessage: message,
        conversationState: {},
    })
    const preRoute = evaluateCustomerPreRoutePolicy({
        message,
        manifest,
        workspaceId,
        stateContext: {},
    })
    const heuristic = heuristicIntent(message, manifest?._domainPackHeuristics || null)
    const resolved = evaluateCustomerResolvedPolicy({
        manifest,
        routedIntent: heuristic,
        workspaceId,
        domainPack: pack,
    })
    const flowConfig = require("../config/settings.json").flows?.customer || {}
    const execution = decideCustomerExecution({
        flowConfig,
        routedIntent: heuristic,
        manifest,
    })

    const steps = [
        makeStep("Sanitize", "pass", "Input is inspected for prompt injection and dangerous patterns."),
        makeStep("Domain Gate", summarizeStatus(preRoute.allowed), preRoute.allowed ? "Message remains inside customer domain policy." : (preRoute.response || preRoute.reason)),
        makeStep("Intent Match", resolved.allowed ? "pass" : "fail", `Heuristic intent: ${heuristic.intent}`),
        makeStep("Execution Route", execution.mode === "tool" ? "pass" : "warn", `${execution.mode} path selected because ${execution.reason}.`),
    ]
    const toolName = manifest?.intents?.[heuristic.intent]?.tool || null
    const toolConfig = toolName ? manifest?.tools?.[toolName] : null

    return {
        flow: "customer",
        status: resolved.allowed && preRoute.allowed ? (execution.mode === "backend" ? "warn" : "pass") : "fail",
        summary: preRoute.allowed
            ? `Customer flow predicts intent "${heuristic.intent}" and would route to ${execution.mode}${toolName ? ` using "${toolName}"` : ""}.`
            : `Customer flow would be blocked before routing because ${preRoute.reason}.`,
        steps,
        details: {
            intent: heuristic.intent,
            filters: heuristic.filter || {},
            policyReason: resolved.reason,
            toolName,
            toolType: toolConfig?.type || "",
            executionMode: execution.mode,
            executionReason: execution.reason,
        },
    }
}

function previewPrivileged(flow, rawMessage, workspaceId) {
    const cfg = require("../config/settings.json")
    const commandText = String(rawMessage || "").trim()
    const governance = getGovernanceSnapshot(cfg.admin?.role, workspaceId)
    const inferredTool = inferAdminTool(commandText)
    const decision = authorizeToolCall({
        tool: inferredTool,
        worker: "operator",
        role: governance.role,
        task: commandText,
        workspaceId,
    })
    const steps = [
        makeStep("Flow Access", "pass", `${flow} hotword detected. In production the number and PIN gates would be checked here.`),
        makeStep("Intent Inference", "pass", `Likely operational tool: ${inferredTool}.`),
        makeStep("Governance", decision.allowed ? (decision.requiresApproval ? "warn" : "pass") : "fail", decision.allowed ? `Tool is allowed for role ${decision.role}.` : decision.reason),
        makeStep("Execution", decision.allowed ? (decision.requiresApproval ? "warn" : "pass") : "fail", decision.requiresApproval ? "Execution would pause for explicit approval before proceeding." : "This preview never executes real tools."),
    ]

    return {
        flow,
        status: decision.allowed ? (decision.requiresApproval ? "warn" : "pass") : "fail",
        summary: decision.allowed
            ? `${flow[0].toUpperCase()}${flow.slice(1)} flow predicts tool "${inferredTool}" and governance ${decision.requiresApproval ? "would require approval" : "would allow it"}.`
            : `${flow[0].toUpperCase()}${flow.slice(1)} flow predicts tool "${inferredTool}", but governance would block it.`,
        steps,
        details: {
            inferredTool,
            governance: {
                allowed: !!decision.allowed,
                requiresApproval: !!decision.requiresApproval,
                reason: decision.reason,
                role: decision.role,
                worker: decision.worker,
                risk: decision.risk || "",
                category: decision.category || "",
            },
        },
    }
}

function buildDemoPreview(message, workspaceId) {
    const sanitized = sanitize(message)
    if (!sanitized.safe) {
        return {
            ok: true,
            flow: "blocked",
            status: "fail",
            summary: "The public preview rejected this message at the sanitizer layer.",
            steps: [
                makeStep("Sanitize", "fail", sanitized.reason),
            ],
            details: {
                reason: sanitized.reason,
            },
        }
    }

    const detected = detectFlow(message, workspaceId)
    if (detected.flow === "customer") return { ok: true, ...previewCustomer(detected.commandText, workspaceId) }
    return { ok: true, ...previewPrivileged(detected.flow, detected.commandText, workspaceId) }
}

module.exports = {
    buildDemoPreview,
}
