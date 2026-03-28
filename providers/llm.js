"use strict"

const { normalizeCustomerExecutionConfig } = require("../runtime/customerExecutionConfig")

function getSettings() {
    delete require.cache[require.resolve("../config/settings.json")]
    return require("../config/settings.json")
}

const ADAPTERS = {
    openai:    require("./adapters/openai"),
    anthropic: require("./adapters/anthropic"),
    ollama:    require("./adapters/ollama"),
    mlx:       require("./adapters/mlx"),
    backend:   require("./adapters/backend"),
}

const FLOWS = ["customer", "admin", "agent"]

/**
 * Get the LLM configuration for a specific flow.
 */
function getFlowConfig(flowName = "customer") {
    const settings = getSettings()
    const flows = settings.flows || {}
    const cfg = flows[flowName] || {}
    const llm = cfg.llm || {}

    // Backwards compatibility fallbacks
    let baseLlm = {}
    if (flowName === "customer") baseLlm = settings.customer?.llm || settings.llm || settings.ollama || {}
    else if (flowName === "admin") baseLlm = settings.admin?.llm || {}
    else if (flowName === "agent") baseLlm = settings.agent?.llm || settings.admin?.agent_llm || settings.admin?.llm || {}

    return {
        ...baseLlm,
        ...llm,
        backend: cfg.backend || settings[flowName]?.backend || (flowName === "agent" ? settings.admin?.agent_backend : undefined) || "direct",
        endpoint: cfg.endpoint || llm.endpoint || llm.base_url || llm.url || "",
        backend_config: cfg.backend_config || {},
        tools: cfg.tools || (flowName === "admin" ? settings.admin?.tools : (flowName === "agent" ? settings.admin?.agent_tools : undefined)) || [],
        execution: flowName === "customer" ? normalizeCustomerExecutionConfig(cfg.execution || {}) : (cfg.execution || {}),
    }
}

/**
 * Send a prompt to the configured LLM provider for a specific flow.
 * @param {string|Array} input
 * @param {Object} [options]
 * @returns {Promise<string>}
 */
async function complete(input, options = {}) {
    const flowName = options.flow || "customer"
    const cfg = {
        ...getFlowConfig(flowName),
        ...(options.llmConfig || {}),
    }

    const providerKey = (cfg.backend && cfg.backend !== "direct") ? "backend" : (cfg.provider || "openai")
    const AdapterClass = ADAPTERS[providerKey] || ADAPTERS.openai
    
    const adapter = new AdapterClass(cfg)
    
    try {
        const result = await adapter.complete(input, options)
        if (!result) {
            console.warn(`LLM provider ${providerKey} returned an empty response.`)
        }
        return result
    } catch (e) {
        console.error(`LLM provider ${providerKey} error:`, e.message)
        return ""
    }
}

/**
 * List models for a provider.
 */
async function listModels(provider, config = {}) {
    const AdapterClass = ADAPTERS[provider]
    if (!AdapterClass) return []
    const adapter = new AdapterClass(config)
    return await adapter.listModels()
}

module.exports = { complete, listModels, getFlowConfig }
