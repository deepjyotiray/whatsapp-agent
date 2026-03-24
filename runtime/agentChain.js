"use strict"

const fs   = require("fs")
const yaml = require("js-yaml")
const path = require("path")

const { sanitize }                       = require("../gateway/sanitizer")
const { routeCustomerMessage }           = require("../gateway/customerRouter")
const { isAdmin, parseAdminMessage, handleAdmin } = require("../gateway/admin")
const { getGovernanceSnapshot }          = require("../gateway/adminGovernance")
const { dispatchAgentTask }               = require("../gateway/adminAgent")
const cartStore                          = require("../tools/cartStore")
const executor                           = require("./executor")
const logger                             = require("../gateway/logger")
const { addTurn }                        = require("./sessionMemory")
const { getActiveWorkspace }             = require("../core/workspace")
const { loadPack, getPackForWorkspace }  = require("../core/domainPacks")
const debugInterceptor                   = require("./debugInterceptor")

function isSupportMenuReply(message) {
    const text = String(message || "").trim()
    return text === "0" || /^[1-5]$/.test(text)
}

class AgentChain {
    constructor() {
        this._manifest = null
        this._ready    = false
    }

    async execute(message, phone) {
        if (!this._ready) throw new Error("AgentChain: call loadAgent() first.")

        // Backward compatibility: manifest-defined backend
        if (this._manifest.agent?.backend === "openclaw") {
            const response = await dispatchAgentTask(message, { phone })
            debugInterceptor.logMessage(phone, message, response, "openclaw", "whatsapp", null)
            return response
        }

        // 0. Admin intercept
        const admin = parseAdminMessage(message, phone)
        if (admin.isAdmin) {
            const response = await handleAdmin(admin.payload, { user: admin.user, flow: admin.flow })
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

        // 2. Active session check — skip LLM entirely
        const activeSession = cartStore.get(phone)
        const activeSupport = cartStore.get(`support:${phone}`)

        if (activeSession && activeSession.state === "support_handoff") {
            // active session handed off to support — clear session, route to support
            cartStore.clear(phone)
            return await executor.execute(this._manifest, { intent: "support", filter: {} }, { phone, rawMessage: message })
        }

        if (activeSession) {
            const cartIntent = this._sessionRouting.activeCartIntent || Object.keys(this._manifest.intents)[0] || "general_chat"
            return await executor.execute(this._manifest, { intent: cartIntent, filter: {} }, { phone, rawMessage: message })
        }

        if (activeSupport) {
            if (activeSupport.state === "menu" && !isSupportMenuReply(message)) {
                try {
                    const reroute = await routeCustomerMessage(message, this._manifest)
                    if (reroute.intent && reroute.intent !== "support") {
                        cartStore.clear(`support:${phone}`)
                    } else {
                        return await executor.execute(this._manifest, { intent: "support", filter: {} }, { phone, rawMessage: message })
                    }
                } catch {
                    cartStore.clear(`support:${phone}`)
                }
            } else {
                return await executor.execute(this._manifest, { intent: "support", filter: {} }, { phone, rawMessage: message })
            }
        }

        // 3. Intent router — manifest-driven business classification
        let intent, filter
        try {
            // Check if intent was already parsed by previewEngine in this process
            const { getCachedIntent } = require("./previewEngine")
            const cached = getCachedIntent(phone, message)
            if (cached) {
                intent = cached.intent
                filter = cached.filter || {}
                logger.info({ phone, intent, source: "cache" }, "chain: intent parsed (cached)")
            } else {
                const result = await routeCustomerMessage(message, this._manifest)
                intent = result.intent
                filter = result.filter || {}
                logger.info({ phone, intent }, "chain: intent parsed")
            }
        } catch {
            intent = "general_chat"
            filter = {}
        }

        // 4. Guard — fallback to public concierge if route is unknown
        if (!this._manifest.intents[intent]) {
            intent = this._manifest.intents.general_chat ? "general_chat" : Object.keys(this._manifest.intents)[0]
        }

        // 5. Execute
        try {
            const response = await executor.execute(this._manifest, { intent, filter }, { phone, rawMessage: message })
            if (response) {
                return response
            }

            // check domain gate as fallback for empty/out-of-domain responses
            const { isInDomain } = require("../gateway/policyEngine")
            if (!isInDomain(message, getActiveWorkspace())) {
                return this._manifest.agent.out_of_domain_message || "I can only help with business-related questions."
            }

            return this._manifest.agent.error_message || "I'm sorry, I couldn't process that. How else can I help?"
        } catch (err) {
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
