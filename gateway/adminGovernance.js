"use strict"

const fs = require("fs")
const path = require("path")
const { hasGrantedApproval } = require("./adminApprovals")
const { workspacePath, getActiveWorkspace } = require("../core/workspace")

const ROOT_DIR = path.resolve(__dirname, "..")
const DEFAULT_POLICY_PATH = path.join(ROOT_DIR, "policy", "admin-governance.json")

const RISK_ORDER = { low: 0, medium: 1, high: 2, critical: 3 }

function policyPath(workspaceId = getActiveWorkspace()) {
    return workspacePath(workspaceId, "policy", "admin-governance.json")
}

function auditPath(workspaceId = getActiveWorkspace()) {
    return workspacePath(workspaceId, "logs", "governance.audit.log")
}

function ensureWorkspacePolicy(workspaceId = getActiveWorkspace()) {
    const target = policyPath(workspaceId)
    if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(DEFAULT_POLICY_PATH, target)
    }
    return target
}

function loadPolicy(workspaceId = getActiveWorkspace()) {
    try {
        return JSON.parse(fs.readFileSync(ensureWorkspacePolicy(workspaceId), "utf8"))
    } catch {
        return { defaultRole: "super_admin", roles: {}, workers: {}, tools: {} }
    }
}

function audit(event, details = {}, workspaceId = getActiveWorkspace()) {
    try {
        const target = auditPath(workspaceId)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.appendFileSync(target, JSON.stringify({
            ts: new Date().toISOString(),
            event,
            ...details,
        }) + "\n")
    } catch {}
}

function normalizeRole(policy, requestedRole) {
    return policy.roles?.[requestedRole] ? requestedRole : (policy.defaultRole || "super_admin")
}

function taskAllowsExplicitApproval(task = "") {
    return /\b(approved|approval granted|go ahead and|you may|proceed to|send it|update it|write it|install it|run it)\b/i.test(task)
}

function extractApprovalToken(task = "") {
    const match = String(task).match(/\bapr-[a-z0-9]+-[a-z0-9]+\b/i)
    return match ? match[0] : null
}

function taskSuggestsMutation(task = "") {
    return /\b(send|message|update|change|write|install|run|open|click|fill|type|create|delete|modify|play|execute)\b/i.test(task)
}

function authorizeToolCall(input = {}) {
    const workspaceId = input.workspaceId || getActiveWorkspace()
    const policy = loadPolicy(workspaceId)
    const role = normalizeRole(policy, input.role)
    const worker = input.worker || "operator"
    const tool = input.tool
    const task = input.task || ""
    const toolPolicy = policy.tools?.[tool]

    if (!toolPolicy) {
        const decision = { allowed: false, reason: `Tool '${tool}' is not registered in governance policy.`, role, worker, tool, requiresApproval: false }
        audit("decision", decision, workspaceId)
        return decision
    }

    const workerTools = policy.workers?.[worker] || []
    if (workerTools.length && !workerTools.includes(tool) && role !== "system_admin") {
        const decision = { allowed: false, reason: `${worker} is not allowed to use ${tool}.`, role, worker, tool, requiresApproval: false }
        audit("decision", decision, workspaceId)
        return decision
    }

    if (Array.isArray(toolPolicy.roles) && !toolPolicy.roles.includes(role)) {
        const decision = { allowed: false, reason: `${role} is not allowed to use ${tool}.`, role, worker, tool, requiresApproval: false }
        audit("decision", decision, workspaceId)
        return decision
    }

    const maxRisk = policy.roles?.[role]?.maxRisk || "medium"
    if ((RISK_ORDER[toolPolicy.risk] ?? 0) > (RISK_ORDER[maxRisk] ?? 1)) {
        const decision = { allowed: false, reason: `${tool} exceeds the risk limit for ${role}.`, role, worker, tool, requiresApproval: false }
        audit("decision", decision, workspaceId)
        return decision
    }

    let requiresApproval = false
    if (toolPolicy.approval === "explicit") {
        const approvalToken = extractApprovalToken(task)
        const grantedByToken = approvalToken ? hasGrantedApproval(approvalToken, tool, task.replace(approvalToken, "").trim(), workspaceId) : false
        requiresApproval = !(taskAllowsExplicitApproval(task) || grantedByToken)
    } else if (toolPolicy.approval === "task_intent") {
        requiresApproval = toolPolicy.mutating && !taskSuggestsMutation(task)
    }

    if (requiresApproval) {
        const decision = {
            allowed: false,
            reason: `${tool} requires explicit approval in the task request.`,
            role,
            worker,
            tool,
            requiresApproval: true,
            approvalHint: `Repeat the request with clear approval language such as "approved" or "go ahead and ${tool.replace(/_/g, " ")}".`,
        }
        audit("decision", decision, workspaceId)
        return decision
    }

    const decision = {
        allowed: true,
        reason: "allowed",
        role,
        worker,
        tool,
        requiresApproval: false,
        category: toolPolicy.category,
        risk: toolPolicy.risk,
        mutating: !!toolPolicy.mutating,
    }
    audit("decision", decision, workspaceId)
    return decision
}

function getGovernanceSnapshot(role, workspaceId = getActiveWorkspace()) {
    const policy = loadPolicy(workspaceId)
    const normalizedRole = normalizeRole(policy, role)
    return {
        workspaceId,
        role: normalizedRole,
        rolePolicy: policy.roles?.[normalizedRole] || null,
        workers: policy.workers || {},
        tools: policy.tools || {},
    }
}

function updatePolicy(patch, workspaceId = getActiveWorkspace()) {
    const policy = loadPolicy(workspaceId)
    if (patch.tools) Object.assign(policy.tools, patch.tools)
    if (patch.roles) Object.assign(policy.roles, patch.roles)
    if (patch.workers) Object.assign(policy.workers, patch.workers)
    if (patch.defaultRole) policy.defaultRole = patch.defaultRole
    const target = ensureWorkspacePolicy(workspaceId)
    fs.writeFileSync(target, JSON.stringify(policy, null, 2))
    audit("policy_update", { patch }, workspaceId)
    return policy
}

module.exports = {
    authorizeToolCall,
    getGovernanceSnapshot,
    updatePolicy,
}
