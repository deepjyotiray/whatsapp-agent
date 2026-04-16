"use strict"

const fetch = require("node-fetch")
const BaseAdapter = require("./base")

const LOCAL_BACKENDS = new Set(["openclaw", "myclaw", "nemoclaw"])

function flattenContent(content) {
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === "string") return part
            if (part && typeof part.text === "string") return part.text
            return JSON.stringify(part)
        }).join("\n")
    }
    return String(content == null ? "" : content)
}

function buildMessages(input) {
    if (Array.isArray(input)) {
        return input
            .filter(msg => msg && msg.content != null)
            .map(msg => ({
                role: msg.role || "user",
                content: flattenContent(msg.content),
            }))
    }
    return [{ role: "user", content: String(input || "") }]
}

function resolveChatEndpoint(endpoint, backend) {
    const trimmed = String(endpoint || "").trim()
    if (!trimmed) {
        if (backend === "godmod3") return "http://127.0.0.1:7860/v1/chat/completions"
        return ""
    }
    if (/\/v1\/chat\/completions\/?$/.test(trimmed)) return trimmed
    if (/\/v1\/?$/.test(trimmed)) return `${trimmed.replace(/\/+$/, "")}/chat/completions`
    return `${trimmed.replace(/\/+$/, "")}/v1/chat/completions`
}

function resolveApiBase(endpoint, backend) {
    const chatEndpoint = resolveChatEndpoint(endpoint, backend)
    return chatEndpoint ? chatEndpoint.replace(/\/chat\/completions\/?$/, "") : ""
}

function pickNumber(value) {
    const num = Number(value)
    return Number.isFinite(num) ? num : undefined
}

async function readSseText(res) {
    const raw = await res.text()
    if (!raw) return ""

    let output = ""
    const chunks = raw.split(/\n\n+/)
    for (const chunk of chunks) {
        const lines = chunk.split("\n").filter(line => line.startsWith("data:"))
        for (const line of lines) {
            const data = line.replace(/^data:\s*/, "").trim()
            if (!data || data === "[DONE]") continue
            try {
                const parsed = JSON.parse(data)
                const delta = parsed.choices?.[0]?.delta?.content
                if (typeof delta === "string") {
                    output += delta
                    continue
                }
                const message = parsed.choices?.[0]?.message?.content
                if (typeof message === "string") {
                    output += message
                    continue
                }
                if (typeof parsed.response === "string") {
                    output += parsed.response
                }
            } catch {
                // Ignore malformed event lines from upstream.
            }
        }
    }
    return output.trim()
}

/**
 * Backend adapter for systems like OpenClaw, MyClaw, etc.
 * Instead of direct LLM calls, it routes to a backend task dispatcher.
 */
class BackendAdapter extends BaseAdapter {
    async complete(input, options = {}) {
        const backend = this.config.backend || this.config.backend_type || "openclaw"
        const messages = buildMessages(input)
        const prompt = messages.map(m => m.content).join("\n")

        if (LOCAL_BACKENDS.has(backend)) {
            const { dispatchAgentTask } = require("../../gateway/adminAgent")
            const backendConfig = this.config.backend_config || {}
            const localMessages = Array.isArray(messages) ? [...messages] : []
            if (backendConfig.custom_system_prompt) {
                localMessages.unshift({
                    role: "system",
                    content: String(backendConfig.custom_system_prompt),
                })
            }
            return await dispatchAgentTask(prompt, {
                ...options,
                phone: options.phone,
                backend,
                endpoint: this.config.endpoint || this.config.base_url,
                backend_config: backendConfig,
                timeout: backendConfig?.timeout || options.timeout,
                flow: options.flow,
                _backend_redirect: options._backend_redirect,
                messages: localMessages,
            })
        }

        const apiBase = resolveApiBase(this.config.endpoint || this.config.base_url, backend)
        if (!apiBase) {
            throw new Error(`Backend "${backend}" requires an endpoint`)
        }

        const backendConfig = this.config.backend_config || {}
        const stream = !!backendConfig.stream
        const headers = {
            "Content-Type": "application/json",
        }
        const apiKey = this.config.api_key || backendConfig.api_key || process.env.GODMODE_API_KEY || process.env.BACKEND_API_KEY
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`

        const model = options.model || this.config.model || backendConfig.model || (backend === "godmod3" ? "ultraplinian/fast" : undefined)
        const openrouterApiKey = backendConfig.openrouter_api_key || process.env.OPENROUTER_API_KEY
        const numericConfig = {
            temperature: options.temperature !== undefined ? options.temperature : pickNumber(backendConfig.temperature),
            max_tokens: options.max_tokens !== undefined ? options.max_tokens : pickNumber(backendConfig.max_tokens),
            top_p: pickNumber(backendConfig.top_p),
            top_k: pickNumber(backendConfig.top_k),
            frequency_penalty: pickNumber(backendConfig.frequency_penalty),
            presence_penalty: pickNumber(backendConfig.presence_penalty),
            repetition_penalty: pickNumber(backendConfig.repetition_penalty),
        }

        const systemMessages = backend === "godmod3"
            ? messages.filter(m => m.role === "system").map(m => m.content).filter(Boolean)
            : []
        const nonSystemMessages = backend === "godmod3"
            ? messages.filter(m => m.role !== "system")
            : messages

        const customSystemPromptParts = []
        if (systemMessages.length) customSystemPromptParts.push(systemMessages.join("\n\n"))
        if (backendConfig.custom_system_prompt) customSystemPromptParts.push(String(backendConfig.custom_system_prompt))

        const godmod3Body = {
            messages: nonSystemMessages.length ? nonSystemMessages : messages,
            ...(openrouterApiKey ? { openrouter_api_key: openrouterApiKey } : {}),
            ...(backendConfig.godmode_enabled !== undefined ? { godmode: !!backendConfig.godmode_enabled } : {}),
            ...(customSystemPromptParts.length ? { custom_system_prompt: customSystemPromptParts.join("\n\n") } : {}),
            ...(backendConfig.autotune !== undefined ? { autotune: !!backendConfig.autotune } : {}),
            ...(backendConfig.strategy ? { strategy: backendConfig.strategy } : {}),
            ...(backendConfig.parseltongue !== undefined ? { parseltongue: !!backendConfig.parseltongue } : {}),
            ...(backendConfig.parseltongue_technique ? { parseltongue_technique: backendConfig.parseltongue_technique } : {}),
            ...(backendConfig.parseltongue_intensity ? { parseltongue_intensity: backendConfig.parseltongue_intensity } : {}),
            ...(Array.isArray(backendConfig.parseltongue_custom_triggers) && backendConfig.parseltongue_custom_triggers.length
                ? { parseltongue_custom_triggers: backendConfig.parseltongue_custom_triggers }
                : {}),
            ...(Array.isArray(backendConfig.stm_modules) ? { stm_modules: backendConfig.stm_modules } : {}),
            ...(backendConfig.contribute_to_dataset !== undefined ? { contribute_to_dataset: !!backendConfig.contribute_to_dataset } : {}),
            ...Object.fromEntries(Object.entries(numericConfig).filter(([, value]) => value !== undefined)),
        }

        let endpoint = `${apiBase}/chat/completions`
        let body = {
            messages,
            ...(model ? { model } : {}),
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options.max_tokens !== undefined ? { max_tokens: options.max_tokens } : {}),
            ...(options.stop ? { stop: options.stop } : {}),
        }

        if (backend === "godmod3") {
            const ultraMatch = String(model || "").match(/^ultraplinian\/(fast|standard|smart|power|ultra)$/)
            const consortiumMatch = String(model || "").match(/^consortium\/(fast|standard|smart|power|ultra)$/)

            if (ultraMatch) {
                endpoint = `${apiBase}/ultraplinian/completions`
                body = {
                    ...godmod3Body,
                    tier: ultraMatch[1],
                    stream,
                    ...(backendConfig.liquid_min_delta !== undefined ? { liquid_min_delta: pickNumber(backendConfig.liquid_min_delta) } : {}),
                }
            } else if (consortiumMatch) {
                endpoint = `${apiBase}/consortium/completions`
                body = {
                    ...godmod3Body,
                    tier: consortiumMatch[1],
                    stream,
                    ...(backendConfig.liquid !== undefined ? { liquid: !!backendConfig.liquid } : {}),
                    ...(backendConfig.liquid_min_delta !== undefined ? { liquid_min_delta: pickNumber(backendConfig.liquid_min_delta) } : {}),
                    ...(backendConfig.orchestrator_model ? { orchestrator_model: backendConfig.orchestrator_model } : {}),
                }
            } else {
                body = {
                    ...godmod3Body,
                    ...(model ? { model } : {}),
                    stream,
                }
            }
        } else if (openrouterApiKey) {
            body.openrouter_api_key = openrouterApiKey
        }

        const res = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        })

        if (!res.ok) {
            const errText = await res.text()
            throw new Error(`Backend ${backend} error: ${res.status} ${errText}`)
        }

        if (backend === "godmod3" && body.stream) {
            const streamed = await readSseText(res)
            if (options.fullResponse) return { output_text: streamed, streamed: true }
            return streamed
        }

        const data = await res.json()
        if (options.fullResponse) return data
        return (data.choices?.[0]?.message?.content || data.output_text || data.response || "").trim()
    }

    async listModels() {
        const backend = this.config.backend || this.config.backend_type || "openclaw"
        if (LOCAL_BACKENDS.has(backend)) return []

        const endpoint = resolveChatEndpoint(this.config.endpoint || this.config.base_url, backend)
        if (!endpoint) return []
        const modelsUrl = endpoint.replace(/\/chat\/completions\/?$/, "/models")
        const headers = {}
        const apiKey = this.config.api_key || this.config.backend_config?.api_key || process.env.GODMODE_API_KEY || process.env.BACKEND_API_KEY
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`

        try {
            const res = await fetch(modelsUrl, { headers })
            if (!res.ok) return []
            const data = await res.json()
            return (data.data || []).map(model => model.id).filter(Boolean)
        } catch {
            return []
        }
    }
}

module.exports = BackendAdapter
