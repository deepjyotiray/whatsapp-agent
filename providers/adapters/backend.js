"use strict"

const BaseAdapter = require("./base")

/**
 * Backend adapter for systems like OpenClaw, MyClaw, etc.
 * Instead of direct LLM calls, it routes to a backend task dispatcher.
 */
class BackendAdapter extends BaseAdapter {
    async complete(input, options = {}) {
        const prompt = typeof input === 'string' ? input : input.map(m => m.content).join("\n")
        const messages = Array.isArray(input) ? input : null
        
        // Use dispatchAgentTask which is already plumbed for OpenClaw/Backend systems
        const { dispatchAgentTask } = require("../../gateway/adminAgent")
        const response = await dispatchAgentTask(prompt, { 
            phone: options.phone,
            backend: this.config.backend || this.config.backend_type || 'openclaw',
            endpoint: this.config.endpoint || this.config.base_url,
            flow: options.flow,
            _backend_redirect: options._backend_redirect,
            messages,
        })
        
        return response
    }
}

module.exports = BackendAdapter
