"use strict"

const fs   = require("fs")
const yaml = require("js-yaml")
const path = require("path")

const { sanitize }                       = require("../gateway/sanitizer")
const { routeCustomerMessage }           = require("../gateway/customerRouter")
const { isAdmin, parseAdminMessage, handleAdmin } = require("../gateway/admin")
const { getGovernanceSnapshot }          = require("../gateway/adminGovernance")
const cartStore                          = require("../tools/cartStore")
const executor                           = require("./executor")
const logger                             = require("../gateway/logger")
const { addTurn }                        = require("./sessionMemory")

function isSupportMenuReply(message) {
    const text = String(message || "").trim()
    return text === "0" || /^[1-5]$/.test(text)
}

class AgentChain {
    constructor() {
        this._manifest = null
        this._ready    = false
    }

    loadAgent(manifestPath) {
        const resolved = path.resolve(manifestPath)
        if (!fs.existsSync(resolved)) throw new Error(`Manifest not found: ${resolved}`)
        this._manifest = yaml.load(fs.readFileSync(resolved, "utf8"))
        if (!this._manifest.agent?.name) throw new Error("Manifest missing agent.name")
        if (!this._manifest.intents)     throw new Error("Manifest missing intents")
        if (!this._manifest.tools)       throw new Error("Manifest missing tools")
        this._ready = true
        logger.info({ agent: this._manifest.agent.name }, "chain: loaded")
    }

    async execute(message, phone) {
        if (!this._ready) throw new Error("AgentChain: call loadAgent() first.")

        // 0. Admin intercept
        if (isAdmin(phone)) {
            const admin = parseAdminMessage(message)
            if (admin.isAdmin) return await handleAdmin(admin.payload)
        }

        // 1. Sanitizer
        const sanity = sanitize(message)
        if (!sanity.safe) {
            logger.warn({ phone, reason: sanity.reason }, "chain: sanitizer blocked")
            return "Your message could not be processed."
        }

        // 2. Active session check — skip LLM entirely
        const activeCart    = cartStore.get(phone)
        const activeSupport = cartStore.get(`support:${phone}`)

        if (activeCart && activeCart.state === "support_handoff") {
            // user picked support from order menu — clear order cart, route to support
            cartStore.clear(phone)
            return await executor.execute(this._manifest, { intent: "support", filter: {} }, { phone, rawMessage: message })
        }

        if (activeCart) {
            return await executor.execute(this._manifest, { intent: "place_order", filter: {} }, { phone, rawMessage: message })
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
            const result = await routeCustomerMessage(message, this._manifest)
            intent = result.intent
            filter = result.filter || {}
        } catch {
            intent = "general_chat"
            filter = {}
        }

        logger.info({ phone, intent }, "chain: intent parsed")

        // 4. Guard — fallback to public concierge if route is unknown
        if (!this._manifest.intents[intent]) {
            intent = this._manifest.intents.general_chat ? "general_chat" : "place_order"
        }

        // 5. Execute
        try {
            const response = await executor.execute(this._manifest, { intent, filter }, { phone, rawMessage: message })
            if (response !== null && response !== undefined) {
                addTurn(phone, message, response, intent)
                return response
            }
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
}

module.exports = new AgentChain()
