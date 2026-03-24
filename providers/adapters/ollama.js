"use strict"

const fetch = require("node-fetch")
const BaseAdapter = require("./base")

class OllamaAdapter extends BaseAdapter {
    async complete(input, options = {}) {
        const baseUrl = this.config.base_url || "http://localhost:11434"
        const model = options.model || this.config.model
        const messages = this._formatMessages(input)

        const res = await fetch(`${baseUrl}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model,
                messages,
                stream: false,
                options: {
                    temperature: options.temperature ?? this.config.temperature,
                    num_predict: options.max_tokens ?? this.config.max_tokens,
                    stop: options.stop || this.config.stop
                }
            })
        })

        if (!res.ok) {
            const err = await res.text()
            throw new Error(`Ollama error: ${res.status} ${err}`)
        }

        const data = await res.json()
        return (data.message?.content || "").trim()
    }

    async listModels() {
        const baseUrl = this.config.base_url || "http://localhost:11434"
        try {
            const res = await fetch(`${baseUrl}/api/tags`)
            if (!res.ok) return []
            const data = await res.json()
            return (data.models || []).map(m => m.name)
        } catch {
            return []
        }
    }
}

module.exports = OllamaAdapter
