"use strict"

const fetch = require("node-fetch")
const BaseAdapter = require("./base")

class OpenAIAdapter extends BaseAdapter {
    async complete(input, options = {}) {
        const url = this.config.base_url || "https://api.openai.com/v1/chat/completions"
        const apiKey = this.config.api_key || process.env.OPENAI_API_KEY
        
        const messages = this._formatMessages(input)
        const model = options.model || this.config.model || "gpt-4o-mini"
        
        const body = {
            model,
            messages,
            temperature: options.temperature ?? this.config.temperature ?? 0.3,
            max_tokens: options.max_tokens ?? this.config.max_tokens,
            stop: options.stop || this.config.stop
        }

        if (options.tools) {
            body.tools = options.tools
            if (options.tool_choice) body.tool_choice = options.tool_choice
        }

        const res = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify(body)
        })

        if (!res.ok) {
            const err = await res.text()
            // Special handling for rate limits to allow retries in high-level loops
            if (res.status === 429) {
                const error = new Error(`OpenAI Rate Limit`)
                error.status = 429
                error.data = err
                throw error
            }
            throw new Error(`OpenAI error: ${res.status} ${err}`)
        }

        const data = await res.json()
        if (options.fullResponse) return data
        return (data.choices?.[0]?.message?.content || "").trim()
    }

    async listModels() {
        const url = (this.config.base_url || "https://api.openai.com/v1").replace(/\/chat\/completions$/, "") + "/models"
        const apiKey = this.config.api_key || process.env.OPENAI_API_KEY
        try {
            const res = await fetch(url, {
                headers: { "Authorization": `Bearer ${apiKey}` }
            })
            if (!res.ok) return []
            const data = await res.json()
            return (data.data || []).map(m => m.id)
        } catch {
            return []
        }
    }
}

module.exports = OpenAIAdapter
