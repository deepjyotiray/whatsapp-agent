"use strict"

const fs   = require("fs")
const yaml = require("js-yaml")
const path = require("path")

const { sanitize }                       = require("../gateway/sanitizer")
const { isAdmin, parseAdminMessage, handleAdmin } = require("../gateway/admin")
const { getGovernanceSnapshot }          = require("../gateway/adminGovernance")
const executor                           = require("./executor")
const logger                             = require("../gateway/logger")
const flowMemory                         = require("./flowMemory")
const conversationState                  = require("./conversationState")
const { getActiveWorkspace }             = require("../core/workspace")
const { getPackForWorkspace }            = require("../core/domainPacks")
const debugInterceptor                   = require("./debugInterceptor")
const { getFlowConfig, complete }        = require("../providers/llm")
const { buildCustomerBackendMessages, LIGHT_BACKEND_INTENTS, getCachedContext, setCachedContext } = require("./customerContext")
const { executeCustomerFlow }            = require("./customerFlow")
const { validateCustomerBackendResponse } = require("./customerResponseGuard")
const { recordCustomerOutcome }          = require("./customerOutcome")
const { loadProfile }                    = require("../setup/profileService")
const { loadNotes }                      = require("../core/dataModelNotes")
const { buildDbContext, getDbSchema, selectRelevantTables } = require("../gateway/admin")

async function loadCustomerRagHints(message, dbPath) {
    try {
        if (!dbPath) return ""
        const rag = require("../tools/genericRagTool")
        const result = await rag.execute({}, { rawMessage: message, skipLlm: true }, { db_path: dbPath })
        if (!result || /nothing matched/i.test(result)) return ""
        return result.split("\n").slice(0, 12).join("\n")
    } catch {
        return ""
    }
}

async function answerCustomerViaConfiguredMode(resolvedRequest, phone, manifest, routedIntent = {}, conversationStateOverride = null, policyContext = null) {
    const message = resolvedRequest.effectiveMessage || resolvedRequest.originalMessage || ""
    const workspaceId = getActiveWorkspace()
    const flowCfg = getFlowConfig("customer")
    const profile = loadProfile(workspaceId)
    const dbPath = profile.dbPath
    const intent = routedIntent.intent || resolvedRequest.lastIntent || "general_chat"
    const useLightContext = LIGHT_BACKEND_INTENTS.has(intent)
    let relevantTables = null
    let dbContext = ""
    let schema = ""
    const notes = loadNotes(workspaceId)
    let ragHints = ""
    const history = flowMemory.getHistory("customer", phone)

    if (!useLightContext) {
        const relevantStart = Date.now()
        relevantTables = await selectRelevantTables(message, workspaceId)
        logger.info({ phone, intent, durationMs: Date.now() - relevantStart, tables: relevantTables }, "perf: customer relevant tables")

        const cached = getCachedContext(workspaceId, relevantTables)
        if (cached) {
            dbContext = cached.dbContext
            schema = cached.schema
        } else {
            const contextStart = Date.now()
            dbContext = await buildDbContext(workspaceId, relevantTables)
            schema = dbPath ? getDbSchema(dbPath, relevantTables) : ""
            setCachedContext(workspaceId, relevantTables, { dbContext, schema })
            logger.info({ phone, intent, durationMs: Date.now() - contextStart }, "perf: customer db context built")
        }

        const ragStart = Date.now()
        ragHints = await loadCustomerRagHints(message, dbPath)
        logger.info({ phone, intent, durationMs: Date.now() - ragStart }, "perf: customer rag hints")
    }

    const activeConversationState = conversationStateOverride || conversationState.getState("customer", phone)
    const messages = buildCustomerBackendMessages({
        message,
        phone,
        manifest,
        profile,
        history,
        conversationState: activeConversationState,
        resolvedRequest,
        dbContext,
        schema,
        notes,
        ragHints,
        policyContext,
    })
    logger.info({ phone, intent, lightContext: useLightContext, messageCount: messages.length }, "perf: customer backend request prepared")
    const llmStart = Date.now()
    const response = await complete(messages, { flow: "customer", llmConfig: flowCfg, phone })
    logger.info({ phone, intent, durationMs: Date.now() - llmStart }, "perf: customer backend completion")
    return response || manifest.agent.error_message || "I'm sorry, I couldn't process that right now."
}

class AgentChain {
    constructor() {
        this._manifest = null
        this._ready    = false
    }

    async _executeAndStore(intent, context, originalMessage, phone) {
        context.conversationState = context.conversationState || conversationState.getState("customer", phone)
        const response = await executor.execute(this._manifest, intent, context)
        if (response) {
            recordCustomerOutcome({
                phone,
                message: originalMessage,
                response,
                manifest: this._manifest,
                domainPack: this._domainPack,
                effectiveMessage: context.rawMessage,
                routedIntent: {
                    intent: intent.intent,
                    filter: context.resolvedRequest?.appliedFilters || intent.filter || {},
                },
                resolvedRequest: context.resolvedRequest,
                resolved: context.resolvedMeta,
                route: context.flow || "customer",
                task: intent.intent,
                executionMeta: {
                    mode: "tool",
                    reason: "tool_execution",
                    backend: "direct",
                    strategy: getFlowConfig("customer").execution?.strategy || "auto",
                },
            })
        }
        return response
    }

    async execute(message, phone) {
        if (!this._ready) throw new Error("AgentChain: call loadAgent() first.")

        // 0. Admin intercept
        const admin = parseAdminMessage(message, phone)
        if (admin.isAdmin) {
            const response = await handleAdmin(admin.payload, { user: admin.user, flow: admin.flow, phone })
            debugInterceptor.logMessage(phone, message, response, "admin", "whatsapp", null)
            return response
        }
        if (admin.matchedFlow && admin.message) {
            debugInterceptor.logMessage(phone, message, admin.message, "admin_auth", "whatsapp", null)
            return admin.message
        }

        // 1. Sanitizer
        const sanity = sanitize(message)
        if (!sanity.safe) {
            logger.warn({ phone, reason: sanity.reason }, "chain: sanitizer blocked")
            return "Your message could not be processed."
        }

        const currentConversationState = conversationState.getState("customer", phone)

        try {
            const outcome = await executeCustomerFlow({
                message,
                phone,
                manifest: this._manifest,
                domainPack: this._domainPack,
                sessionRouting: this._sessionRouting,
                conversationState: currentConversationState,
                executeIntent: ({ intent, effectiveMessage, resolvedMeta, resolvedRequest, originalMessage, conversationState: activeTurnState }) => {
                    return this._executeAndStore(intent, { phone, rawMessage: effectiveMessage, resolvedMeta, resolvedRequest, conversationState: activeTurnState }, originalMessage, phone)
                },
                answerViaConfiguredMode: async ({ resolvedRequest, routedIntent, conversationState: activeTurnState, policyContext }) => {
                    return await answerCustomerViaConfiguredMode(resolvedRequest, phone, this._manifest, routedIntent, activeTurnState, policyContext)
                },
            })

            if (outcome.route === "customer_backend") {
                const guardResult = validateCustomerBackendResponse(outcome.response, {
                    execution: outcome.executionConfig,
                    fallback: this._manifest.agent.error_message || "I'm sorry, I couldn't process that right now.",
                })
                const response = guardResult.response
                const effectiveMessage = outcome.turn.effectiveMessage
                const resolved = outcome.turn.resolved
                const resolvedRequest = outcome.turn.resolvedRequest
                const routedIntent = outcome.routedIntent || { intent: "general_chat", filter: {} }
                if (!guardResult.ok) {
                    logger.warn({ phone, issues: guardResult.issues, originalLength: guardResult.originalLength }, "chain: customer backend response guarded")
                }
                recordCustomerOutcome({
                    phone,
                    message,
                    response,
                    manifest: this._manifest,
                    domainPack: this._domainPack,
                    effectiveMessage,
                    routedIntent,
                    resolvedRequest,
                    resolved,
                    route: "customer_backend",
                    task: "customer_backend",
                    executionMeta: {
                        mode: "backend",
                        reason: outcome.executionPlan?.reason || "customer_backend",
                        backend: getFlowConfig("customer").backend || "direct",
                        strategy: outcome.executionConfig?.strategy || "auto",
                        policy: outcome.policy?.reason || "allowed",
                        responseGuardIssues: guardResult.issues,
                    },
                })
                return response
            }

            if (outcome.route === "customer_planner") {
                recordCustomerOutcome({
                    phone,
                    message,
                    response: outcome.response,
                    manifest: this._manifest,
                    domainPack: this._domainPack,
                    effectiveMessage: outcome.turn?.effectiveMessage || message,
                    routedIntent: outcome.routedIntent || { intent: "general_chat", filter: {} },
                    resolvedRequest: outcome.turn?.resolvedRequest || null,
                    resolved: outcome.turn?.resolved || null,
                    route: "customer_planner",
                    task: "customer_planner",
                    executionMeta: {
                        mode: "planner",
                        reason: outcome.plannerDecision?.reason || "customer_planner",
                        backend: "grounded_planner",
                        strategy: outcome.executionConfig?.strategy || "auto",
                        groundedIn: outcome.plannerDecision?.groundedIn || "conversation_state",
                    },
                })
                return outcome.response
            }

            if (outcome.response) {
                if (outcome.route === "policy_blocked") {
                    debugInterceptor.logMessage(phone, message, outcome.response, "policy_blocked", "whatsapp", {
                        reason: outcome.policy?.reason || "blocked",
                        strategy: outcome.executionConfig?.strategy || "auto",
                    })
                }
                return outcome.response
            }

            return this._manifest.agent.error_message || "I'm sorry, I couldn't process that. How else can I help?"
        } catch (err) {
            const intent = err?.intent || "customer_flow"
            logger.error({ phone, intent, err }, "chain: executor error")
        }

        return this._manifest.agent.error_message || "Something went wrong. Please try again."
    }

    getCapabilities() {
        if (!this._ready) return { ready: false }
        const governance = getGovernanceSnapshot()
        return {
            agent:   this._manifest.agent.name,
            intents: Object.keys(this._manifest.intents),
            tools:   Object.keys(this._manifest.tools),
            governance: {
                role: governance.role,
                workerCount: Object.keys(governance.workers || {}).length,
                governedToolCount: Object.keys(governance.tools || {}).length,
            },
        }
    }

    healthCheck() {
        return {
            status:    this._ready ? "ok" : "no_agent",
            agent:     this._manifest?.agent?.name,
            timestamp: new Date().toISOString(),
        }
    }

    getManifestPath() {
        return this._manifestPath
    }

    loadAgent(manifestPath) {
        const resolved = path.resolve(manifestPath)
        if (!fs.existsSync(resolved)) throw new Error(`Manifest not found: ${resolved}`)
        this._manifestPath = resolved
        this._manifest = yaml.load(fs.readFileSync(resolved, "utf8"))
        if (!this._manifest.agent?.name) throw new Error("Manifest missing agent.name")
        if (!this._manifest.intents)     throw new Error("Manifest missing intents")
        if (!this._manifest.tools)       throw new Error("Manifest missing tools")

        // wire domain pack if workspace has one configured
        this._sessionRouting = {}
        this._domainPack = null
        try {
            this._domainPack = this._loadDomainPack()
        } catch (err) {
            logger.warn({ err: err.message }, "chain: domain pack load failed, continuing without")
        }

        this._ready = true
        logger.info({ agent: this._manifest.agent.name, domainPack: this._domainPack?.name || null }, "chain: loaded")
    }

    _loadDomainPack() {
        // try to resolve workspace profile → domainPack field
        let profile
        try {
            const { loadProfile } = require("../setup/profileService")
            const workspaceId = getActiveWorkspace()
            profile = loadProfile(workspaceId)
        } catch { return null }

        const pack = getPackForWorkspace(profile)
        if (!pack) return null

        // register domain pack tool types with executor
        for (const [name, handler] of Object.entries(pack.toolTypes || {})) {
            executor.registerToolType(name, handler)
        }

        // register domain pack risk map with preview engine
        if (pack.riskMap) {
            try {
                const { registerRiskMap } = require("./previewEngine")
                registerRiskMap(pack.riskMap)
            } catch {}
        }

        // attach domain pack config to manifest for customerRouter/intentParser
        if (pack.heuristics) {
            const merged = { ...pack.heuristics }
            if (pack.heuristicIntentMap) merged._intentMap = pack.heuristicIntentMap
            this._manifest._domainPackHeuristics = merged
        }
        if (pack.filterSchema)    this._manifest._domainPackFilterSchema   = pack.filterSchema
        if (pack.filterExamples)  this._manifest._domainPackFilterExamples = pack.filterExamples

        // session routing
        this._sessionRouting = pack.sessionRouting || {}

        logger.info({ pack: pack.name, toolTypes: Object.keys(pack.toolTypes || {}) }, "chain: domain pack wired")
        return pack
    }

    getIntents() {
        if (!this._ready) throw new Error("No agent loaded")
        const hints = this._manifest.intent_hints || {}
        return Object.entries(this._manifest.intents).map(([name, cfg]) => ({
            name,
            tool: cfg.tool,
            auth_required: cfg.auth_required ?? false,
            hint: hints[name] || null,
        }))
    }

    getIntent(name) {
        if (!this._ready) throw new Error("No agent loaded")
        const cfg = this._manifest.intents[name]
        if (!cfg) throw new Error(`Intent '${name}' not found`)
        return { name, tool: cfg.tool, auth_required: cfg.auth_required ?? false, hint: this._manifest.intent_hints?.[name] || null }
    }

    getTools() {
        if (!this._ready) throw new Error("No agent loaded")
        return Object.entries(this._manifest.tools).map(([name, cfg]) => this._resolveToolPaths({ name, ...cfg }))
    }

    getTool(name) {
        if (!this._ready) throw new Error("No agent loaded")
        const cfg = this._manifest.tools[name]
        if (!cfg) throw new Error(`Tool '${name}' not found`)
        return this._resolveToolPaths({ name, ...cfg })
    }

    _resolveToolPaths(tool) {
        const pathKeys = ["db_path", "vectordb_path", "faq_path"]
        for (const k of pathKeys) {
            if (tool[k]) try { tool[k] = fs.realpathSync(path.resolve(tool[k])) } catch {}
        }
        return tool
    }

    addIntent(name, config) {
        if (!this._ready) throw new Error("No agent loaded")
        this._manifest.intents[name] = config
        this._saveManifest()
        return Object.keys(this._manifest.intents)
    }

    addIntentHint(name, hint) {
        if (!this._ready) throw new Error("No agent loaded")
        if (!this._manifest.intent_hints) this._manifest.intent_hints = {}
        this._manifest.intent_hints[name] = hint
        this._saveManifest()
    }

    addTool(name, config) {
        if (!this._ready) throw new Error("No agent loaded")
        this._manifest.tools[name] = config
        this._saveManifest()
        return Object.keys(this._manifest.tools)
    }

    deleteIntent(name) {
        if (!this._ready) throw new Error("No agent loaded")
        if (!this._manifest.intents[name]) throw new Error(`Intent '${name}' not found`)
        delete this._manifest.intents[name]
        this._saveManifest()
        return Object.keys(this._manifest.intents)
    }

    deleteTool(name) {
        if (!this._ready) throw new Error("No agent loaded")
        if (!this._manifest.tools[name]) throw new Error(`Tool '${name}' not found`)
        delete this._manifest.tools[name]
        this._saveManifest()
        return Object.keys(this._manifest.tools)
    }

    reloadAgent() {
        if (!this._manifestPath) throw new Error("No agent loaded yet")
        // clear cached settings so require() re-reads from disk
        delete require.cache[require.resolve("../config/settings.json")]
        this.loadAgent(this._manifestPath)
        logger.info("chain: hot-reloaded manifest + settings")
    }

    _saveManifest() {
        fs.writeFileSync(this._manifestPath, yaml.dump(this._manifest, { lineWidth: -1 }), "utf8")
    }
}

module.exports = new AgentChain()
