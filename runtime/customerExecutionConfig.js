"use strict"

const VALID_STRATEGIES = new Set(["auto", "tool_first", "backend_first", "hybrid"])
const DEFAULT_BACKEND_CAPABILITIES = {
    conversational: true,
    structured: false,
    memory: false,
    handoffs: false,
    structured_output: false,
}
const DEFAULT_RESPONSE_POLICY = {
    max_chars: 4000,
    strip_markdown: false,
    disallow_patterns: [],
}
const DEFAULT_BACKEND_TUNING = {
    enabled: false,
    max_tokens_cap: 320,
    temperature_floor: 0.15,
    temperature_ceiling: 0.9,
}
const DEFAULT_RESPONSE_TRANSFORMS = {
    hedge_reducer: false,
    direct_mode: false,
    list_compaction: false,
}
const DEFAULT_BACKEND_ENSEMBLE = {
    enabled: false,
    strategy: "race",
    models: [],
    judge_model: "",
}

function toStringList(value) {
    if (!Array.isArray(value)) return []
    const out = []
    const seen = new Set()
    for (const raw of value) {
        const val = String(raw || "").trim()
        if (!val || seen.has(val)) continue
        seen.add(val)
        out.push(val)
    }
    return out
}

function normalizeCapabilities(value = {}) {
    return {
        conversational: value.conversational !== false,
        structured: !!value.structured,
        memory: !!value.memory,
        handoffs: !!value.handoffs,
        structured_output: !!value.structured_output,
    }
}

function normalizeResponsePolicy(value = {}) {
    const maxCharsRaw = Number(value.max_chars)
    const maxChars = Number.isFinite(maxCharsRaw) ? Math.max(80, Math.min(12000, Math.round(maxCharsRaw))) : DEFAULT_RESPONSE_POLICY.max_chars
    return {
        max_chars: maxChars,
        strip_markdown: !!value.strip_markdown,
        disallow_patterns: toStringList(value.disallow_patterns),
    }
}

function normalizeBackendTuning(value = {}) {
    const maxTokensCap = Number(value.max_tokens_cap)
    const temperatureFloor = Number(value.temperature_floor)
    const temperatureCeiling = Number(value.temperature_ceiling)
    const floor = Number.isFinite(temperatureFloor) ? Math.max(0, Math.min(2, temperatureFloor)) : DEFAULT_BACKEND_TUNING.temperature_floor
    const ceiling = Number.isFinite(temperatureCeiling) ? Math.max(floor, Math.min(2, temperatureCeiling)) : DEFAULT_BACKEND_TUNING.temperature_ceiling
    return {
        enabled: !!value.enabled,
        max_tokens_cap: Number.isFinite(maxTokensCap) ? Math.max(80, Math.min(4000, Math.round(maxTokensCap))) : DEFAULT_BACKEND_TUNING.max_tokens_cap,
        temperature_floor: floor,
        temperature_ceiling: ceiling,
    }
}

function normalizeResponseTransforms(value = {}) {
    return {
        hedge_reducer: !!value.hedge_reducer,
        direct_mode: !!value.direct_mode,
        list_compaction: !!value.list_compaction,
    }
}

function normalizeBackendEnsemble(value = {}) {
    const models = toStringList(value.models)
    return {
        enabled: !!value.enabled,
        strategy: value.strategy === "consensus" ? "consensus" : "race",
        models,
        judge_model: String(value.judge_model || "").trim(),
    }
}

function normalizeCustomerExecutionConfig(value = {}) {
    return {
        strategy: VALID_STRATEGIES.has(value.strategy) ? value.strategy : "auto",
        tool_intents: toStringList(value.tool_intents),
        backend_intents: toStringList(value.backend_intents),
        backend_capabilities: normalizeCapabilities(value.backend_capabilities || {}),
        backend_tuning: normalizeBackendTuning(value.backend_tuning || {}),
        backend_ensemble: normalizeBackendEnsemble(value.backend_ensemble || {}),
        response_policy: normalizeResponsePolicy(value.response_policy || {}),
        response_transforms: normalizeResponseTransforms(value.response_transforms || {}),
    }
}

function validateIntentList(intents, allowedIntents, field, errors) {
    if (!allowedIntents || !allowedIntents.size) return
    for (const intent of intents) {
        if (!allowedIntents.has(intent)) {
            errors.push(`${field} contains unknown intent "${intent}"`)
        }
    }
}

function validateCustomerExecutionConfig(value = {}, allowedIntentNames = []) {
    const errors = []
    const allowedIntents = new Set((allowedIntentNames || []).map(v => String(v || "").trim()).filter(Boolean))
    const normalized = normalizeCustomerExecutionConfig(value)

    if (value.strategy !== undefined && !VALID_STRATEGIES.has(value.strategy)) {
        errors.push(`strategy must be one of: ${Array.from(VALID_STRATEGIES).join(", ")}`)
    }

    validateIntentList(normalized.tool_intents, allowedIntents, "tool_intents", errors)
    validateIntentList(normalized.backend_intents, allowedIntents, "backend_intents", errors)

    const overlaps = normalized.tool_intents.filter(intent => normalized.backend_intents.includes(intent))
    if (overlaps.length) {
        errors.push(`tool_intents and backend_intents overlap: ${overlaps.join(", ")}`)
    }

    const responsePolicy = value.response_policy || {}
    const backendTuning = value.backend_tuning || {}
    const backendEnsemble = value.backend_ensemble || {}
    const responseTransforms = value.response_transforms || {}
    if (responsePolicy.max_chars !== undefined) {
        const maxChars = Number(responsePolicy.max_chars)
        if (!Number.isFinite(maxChars) || maxChars < 80 || maxChars > 12000) {
            errors.push("response_policy.max_chars must be a number between 80 and 12000")
        }
    }

    const capabilities = value.backend_capabilities || {}
    for (const key of Object.keys(capabilities)) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_BACKEND_CAPABILITIES, key)) {
            errors.push(`backend_capabilities contains unsupported key "${key}"`)
            continue
        }
        if (typeof capabilities[key] !== "boolean") {
            errors.push(`backend_capabilities.${key} must be boolean`)
        }
    }

    if (Array.isArray(responsePolicy.disallow_patterns)) {
        for (const pattern of responsePolicy.disallow_patterns) {
            if (!String(pattern || "").trim()) errors.push("response_policy.disallow_patterns cannot contain empty values")
        }
    } else if (responsePolicy.disallow_patterns !== undefined) {
        errors.push("response_policy.disallow_patterns must be an array")
    }

    if (backendTuning.enabled !== undefined && typeof backendTuning.enabled !== "boolean") {
        errors.push("backend_tuning.enabled must be boolean")
    }
    if (backendTuning.max_tokens_cap !== undefined) {
        const value = Number(backendTuning.max_tokens_cap)
        if (!Number.isFinite(value) || value < 80 || value > 4000) {
            errors.push("backend_tuning.max_tokens_cap must be a number between 80 and 4000")
        }
    }
    for (const key of ["temperature_floor", "temperature_ceiling"]) {
        if (backendTuning[key] !== undefined) {
            const value = Number(backendTuning[key])
            if (!Number.isFinite(value) || value < 0 || value > 2) {
                errors.push(`backend_tuning.${key} must be a number between 0 and 2`)
            }
        }
    }
    if (
        backendTuning.temperature_floor !== undefined
        && backendTuning.temperature_ceiling !== undefined
        && Number(backendTuning.temperature_floor) > Number(backendTuning.temperature_ceiling)
    ) {
        errors.push("backend_tuning.temperature_floor cannot exceed backend_tuning.temperature_ceiling")
    }

    if (backendEnsemble.enabled !== undefined && typeof backendEnsemble.enabled !== "boolean") {
        errors.push("backend_ensemble.enabled must be boolean")
    }
    if (backendEnsemble.strategy !== undefined && !["race", "consensus"].includes(String(backendEnsemble.strategy))) {
        errors.push("backend_ensemble.strategy must be one of: race, consensus")
    }
    if (backendEnsemble.models !== undefined) {
        if (!Array.isArray(backendEnsemble.models)) {
            errors.push("backend_ensemble.models must be an array")
        } else {
            for (const model of backendEnsemble.models) {
                if (!String(model || "").trim()) errors.push("backend_ensemble.models cannot contain empty values")
            }
        }
    }
    if (backendEnsemble.judge_model !== undefined && typeof backendEnsemble.judge_model !== "string") {
        errors.push("backend_ensemble.judge_model must be a string")
    }

    for (const key of Object.keys(responseTransforms)) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULT_RESPONSE_TRANSFORMS, key)) {
            errors.push(`response_transforms contains unsupported key "${key}"`)
            continue
        }
        if (typeof responseTransforms[key] !== "boolean") {
            errors.push(`response_transforms.${key} must be boolean`)
        }
    }

    return { ok: errors.length === 0, errors, normalized }
}

module.exports = {
    VALID_STRATEGIES,
    DEFAULT_BACKEND_CAPABILITIES,
    DEFAULT_RESPONSE_POLICY,
    DEFAULT_BACKEND_TUNING,
    DEFAULT_BACKEND_ENSEMBLE,
    DEFAULT_RESPONSE_TRANSFORMS,
    normalizeCustomerExecutionConfig,
    validateCustomerExecutionConfig,
}
