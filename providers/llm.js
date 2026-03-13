"use strict"

const settings = require("../config/settings.json")

const PROVIDERS = {
    ollama:    require("./ollama"),
    openai:    require("./openai"),
    anthropic: require("./anthropic"),
}

const cfg      = settings.llm || settings.ollama  // backwards compat
const provider = PROVIDERS[cfg.provider || "ollama"]

if (!provider) throw new Error(`Unknown LLM provider: ${cfg.provider}. Supported: ${Object.keys(PROVIDERS).join(", ")}`)

/**
 * Send a prompt to the configured LLM provider.
 * @param {string} prompt
 * @returns {Promise<string>}
 */
async function complete(prompt) {
    try {
        return await provider.complete(prompt, cfg)
    } catch {
        return ""
    }
}

module.exports = { complete }
