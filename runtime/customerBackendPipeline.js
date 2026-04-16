"use strict"

const { normalizeCustomerExecutionConfig } = require("./customerExecutionConfig")

function clampNumber(value, min, max, fallback) {
    const num = Number(value)
    if (!Number.isFinite(num)) return fallback
    return Math.max(min, Math.min(max, num))
}

function recentTurnsText(history = []) {
    return (Array.isArray(history) ? history : [])
        .slice(-6)
        .map(turn => String(turn?.text || "").trim())
        .filter(Boolean)
        .join("\n")
        .toLowerCase()
}

function classifyTurn(message = "", routedIntent = {}, conversationState = null, history = []) {
    const text = String(message || "").trim().toLowerCase()
    const intent = String(routedIntent?.intent || "")
    const historyText = recentTurnsText(history)
    const hasQuestion = text.includes("?") || /^(what|which|when|where|why|how|can|do|is|are)\b/.test(text)
    const shortTurn = text.split(/\s+/).filter(Boolean).length <= 10
    const orderSignal = /\b(order|delivery|status|track|cancel|refund|price|cost|available|menu)\b/.test(text)
    const emotionalSignal = /\b(angry|upset|frustrated|issue|problem|complaint|wrong)\b/.test(text)
    const followUpSignal = !!conversationState?.pendingClarification || /\b(that one|same|again|previous|earlier)\b/.test(text)

    if (intent === "greet" || (/^(hi|hello|hey|good morning|good evening)\b/.test(text) && shortTurn)) {
        return "brief"
    }
    if (orderSignal || emotionalSignal || followUpSignal || /subscription|delivery/.test(historyText)) {
        return "precise"
    }
    if (intent === "general_chat" && hasQuestion) {
        return "balanced"
    }
    return "concise"
}

function getProfileSettings(profile) {
    switch (profile) {
        case "brief":
            return {
                temperature: 0.25,
                top_p: 0.85,
                max_tokens: 120,
                instructionHint: "Keep the reply brief and natural. Prefer 1-2 short sentences unless the user explicitly asks for detail.",
            }
        case "precise":
            return {
                temperature: 0.2,
                top_p: 0.8,
                max_tokens: 220,
                instructionHint: "Be precise and operational. Lead with the answer, avoid filler, and do not speculate beyond the provided business context.",
            }
        case "balanced":
            return {
                temperature: 0.45,
                top_p: 0.9,
                max_tokens: 320,
                instructionHint: "Answer clearly and helpfully, with enough detail to resolve the user's question without sounding robotic.",
            }
        default:
            return {
                temperature: 0.35,
                top_p: 0.88,
                max_tokens: 180,
                instructionHint: "Respond concisely and clearly. Keep momentum and avoid repetitive phrasing.",
            }
    }
}

function deriveCustomerBackendOptions(options = {}) {
    const execution = normalizeCustomerExecutionConfig(options.execution || {})
    const tuning = execution.backend_tuning || {}
    if (!tuning.enabled) {
        return {
            modelOptions: {},
            instructionHint: "",
            profile: "disabled",
        }
    }

    const profile = classifyTurn(
        options.message,
        options.routedIntent,
        options.conversationState,
        options.history,
    )
    const settings = getProfileSettings(profile)
    const maxCap = tuning.max_tokens_cap || settings.max_tokens
    const temperatureFloor = tuning.temperature_floor
    const temperatureCeiling = tuning.temperature_ceiling

    return {
        profile,
        instructionHint: settings.instructionHint,
        modelOptions: {
            temperature: clampNumber(settings.temperature, temperatureFloor, temperatureCeiling, settings.temperature),
            top_p: settings.top_p,
            max_tokens: Math.min(settings.max_tokens, maxCap),
        },
    }
}

function normalizeLines(text) {
    return String(text || "")
        .replace(/\r/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
}

function applyHedgeReducer(text) {
    return text
        .replace(/^(?:i think|i believe|i would say|i'd say|maybe|perhaps|it seems)\s+/i, "")
        .replace(/\b(?:i think|i believe|maybe|perhaps)\b/gi, "")
        .replace(/[ \t]{2,}/g, " ")
        .trim()
}

function applyDirectMode(text) {
    return text
        .replace(/^(?:certainly|sure|absolutely|of course|definitely|yes)\s*[!,.-]?\s*/i, "")
        .replace(/^(?:here'?s|here is)\s+(?:what|how)\b/i, match => match.replace(/^(?:here'?s|here is)\s+/i, ""))
        .trim()
}

function applyListCompaction(text) {
    return text
        .replace(/\n[ \t]*[-*][ \t]+/g, "\n- ")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
}

function transformCustomerBackendResponse(response, options = {}) {
    const execution = normalizeCustomerExecutionConfig(options.execution || {})
    const transforms = execution.response_transforms || {}
    let text = String(response || "")
    const applied = []

    if (transforms.hedge_reducer) {
        const next = applyHedgeReducer(text)
        if (next !== text) applied.push("hedge_reducer")
        text = next
    }
    if (transforms.direct_mode) {
        const next = applyDirectMode(text)
        if (next !== text) applied.push("direct_mode")
        text = next
    }
    if (transforms.list_compaction) {
        const next = applyListCompaction(text)
        if (next !== text) applied.push("list_compaction")
        text = next
    }

    return {
        response: normalizeLines(text),
        applied,
    }
}

module.exports = {
    deriveCustomerBackendOptions,
    transformCustomerBackendResponse,
}
