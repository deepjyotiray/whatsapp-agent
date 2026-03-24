"use strict"

/**
 * Base class for all LLM provider adapters.
 * Standardizes request format and response parsing.
 */
class BaseAdapter {
    /**
     * @param {Object} config - Provider-specific configuration (api_key, base_url, model, etc.)
     */
    constructor(config) {
        this.config = config || {}
    }

    /**
     * Send a completion request to the provider.
     * @param {string|Array} input - Prompt string or messages array
     * @param {Object} [options] - Additional runtime options (tools, temperature, etc.)
     * @returns {Promise<string|Object>} - Returns string content or full response object if tools used
     */
    async complete(input, options = {}) {
        throw new Error("complete() not implemented")
    }

    /**
     * Discover available models if supported by the provider.
     * @returns {Promise<Array<string>>}
     */
    async listModels() {
        return []
    }

    /**
     * Format prompt/messages into the provider's native format.
     */
    _formatMessages(input) {
        if (Array.isArray(input)) return input
        return [{ role: "user", content: String(input) }]
    }
}

module.exports = BaseAdapter
