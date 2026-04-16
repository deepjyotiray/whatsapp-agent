"use strict"

const { normalizeCustomerExecutionConfig } = require("./customerExecutionConfig")

const PRESETS = {
    openclaw: {
        id: "openclaw",
        name: "OpenClaw Default",
        description: "Balanced customer routing with conversational backend support and strict response guarding.",
        backend_config: {
            command: "openclaw",
            timeout: 90,
        },
        execution: {
            strategy: "auto",
            tool_intents: ["support", "place_order", "order_status", "policy_info", "show_menu"],
            backend_intents: ["general_chat", "greet"],
            backend_capabilities: {
                conversational: true,
                structured: false,
                memory: true,
                handoffs: false,
                structured_output: false,
            },
            response_policy: {
                max_chars: 1200,
                strip_markdown: false,
                disallow_patterns: ["system prompt", "internal policy"],
            },
            backend_tuning: {
                enabled: true,
                max_tokens_cap: 220,
                temperature_floor: 0.15,
                temperature_ceiling: 0.7,
            },
            backend_ensemble: {
                enabled: false,
                strategy: "race",
                models: [],
                judge_model: "",
            },
            response_transforms: {
                hedge_reducer: true,
                direct_mode: true,
                list_compaction: true,
            },
        },
    },
    myclaw: {
        id: "myclaw",
        name: "MyClaw Structured",
        description: "Tool-heavy mode with backend support for richer structured and memory-backed follow-ups.",
        backend_config: {
            command: "openclaw",
            timeout: 90,
        },
        execution: {
            strategy: "hybrid",
            tool_intents: ["support", "place_order", "order_status"],
            backend_intents: ["general_chat"],
            backend_capabilities: {
                conversational: true,
                structured: true,
                memory: true,
                handoffs: true,
                structured_output: true,
            },
            response_policy: {
                max_chars: 1000,
                strip_markdown: true,
                disallow_patterns: ["system prompt", "hidden instructions"],
            },
            backend_tuning: {
                enabled: true,
                max_tokens_cap: 260,
                temperature_floor: 0.15,
                temperature_ceiling: 0.65,
            },
            backend_ensemble: {
                enabled: false,
                strategy: "race",
                models: [],
                judge_model: "",
            },
            response_transforms: {
                hedge_reducer: true,
                direct_mode: true,
                list_compaction: true,
            },
        },
    },
    nemoclaw: {
        id: "nemoclaw",
        name: "NemoClaw Concierge",
        description: "Backend-led conversational assistant with graceful fallback to tools for strict business actions.",
        backend_config: {
            command: "openclaw",
            timeout: 90,
        },
        execution: {
            strategy: "backend_first",
            tool_intents: ["place_order", "order_status", "support"],
            backend_intents: ["general_chat", "greet"],
            backend_capabilities: {
                conversational: true,
                structured: true,
                memory: false,
                handoffs: false,
                structured_output: false,
            },
            response_policy: {
                max_chars: 900,
                strip_markdown: true,
                disallow_patterns: ["system prompt", "internal policy"],
            },
            backend_tuning: {
                enabled: true,
                max_tokens_cap: 240,
                temperature_floor: 0.15,
                temperature_ceiling: 0.75,
            },
            backend_ensemble: {
                enabled: false,
                strategy: "race",
                models: [],
                judge_model: "",
            },
            response_transforms: {
                hedge_reducer: true,
                direct_mode: true,
                list_compaction: false,
            },
        },
    },
    godmod3: {
        id: "godmod3",
        name: "G0DM0D3 Racing",
        description: "OpenAI-compatible G0DM0D3 backend with multi-model racing for conversational queries and tool fallback for business actions.",
        llm: {
            model: "ultraplinian/fast",
        },
        endpoint: "http://127.0.0.1:7860",
        backend_config: {
            timeout: 90,
            godmode_enabled: true,
            autotune: true,
            strategy: "adaptive",
            parseltongue: true,
            parseltongue_technique: "leetspeak",
            parseltongue_intensity: "medium",
            stm_modules: ["hedge_reducer", "direct_mode"],
            liquid: true,
            liquid_min_delta: 8,
            stream: false,
        },
        execution: {
            strategy: "backend_first",
            tool_intents: ["place_order", "order_status", "support", "show_menu", "policy_info"],
            backend_intents: ["general_chat"],
            backend_capabilities: {
                conversational: true,
                structured: false,
                memory: false,
                handoffs: false,
                structured_output: false,
            },
            response_policy: {
                max_chars: 1400,
                strip_markdown: false,
                disallow_patterns: ["system prompt", "internal policy", "hidden instructions"],
            },
            backend_tuning: {
                enabled: true,
                max_tokens_cap: 320,
                temperature_floor: 0.15,
                temperature_ceiling: 0.9,
            },
            backend_ensemble: {
                enabled: false,
                strategy: "race",
                models: [],
                judge_model: "",
            },
            response_transforms: {
                hedge_reducer: true,
                direct_mode: true,
                list_compaction: true,
            },
        },
    },
}

function listCustomerBackendPresets() {
    return Object.values(PRESETS).map(preset => ({
        ...preset,
        execution: normalizeCustomerExecutionConfig(preset.execution),
    }))
}

function getCustomerBackendPreset(id) {
    const preset = PRESETS[id]
    if (!preset) return null
    return {
        ...preset,
        execution: normalizeCustomerExecutionConfig(preset.execution),
    }
}

module.exports = {
    listCustomerBackendPresets,
    getCustomerBackendPreset,
}
