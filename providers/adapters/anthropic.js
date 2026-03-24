"use strict"

const fetch = require("node-fetch")
const BaseAdapter = require("./base")

class AnthropicAdapter extends BaseAdapter {
    async complete(input, options = {}) {
        const url = this.config.base_url || "https://api.anthropic.com/v1/messages"
        const apiKey = this.config.api_key
        
        const messages = this._formatMessages(input)
        const model = options.model || this.config.model || "claude-3-haiku-20240307"

        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                "anthropic-version": "2023-06-01"
            },
            body: JSON.stringify({
                model,
                max_tokens: options.max_tokens || this.config.max_tokens || 1024,
                temperature: options.temperature ?? this.config.temperature,
                stop_sequences: options.stop || this.config.stop,
                messages: messages.filter(m => m.role !== 'system'),
                system: messages.find(m => m.role === 'system')?.content
            })
        })

        if (!res.ok) {
            const err = await res.text()
            throw new Error(`Anthropic error: ${res.status} ${err}`)
        }

        const data = await res.json()
        return (data.content?.[0]?.text || "").trim()
    }
}

module.exports = AnthropicAdapter
