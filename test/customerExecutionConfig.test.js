"use strict"

const { validateCustomerExecutionConfig } = require("../runtime/customerExecutionConfig")
const { validateCustomerBackendResponse } = require("../runtime/customerResponseGuard")
const { decideCustomerExecution } = require("../runtime/flowOrchestrator")
const { deriveCustomerBackendOptions, transformCustomerBackendResponse } = require("../runtime/customerBackendPipeline")
const { pickRaceWinner } = require("../runtime/customerBackendEnsemble")

let passed = 0
let failed = 0
let total = 0

function assert(label, checks) {
    total++
    const errors = checks.filter(([, ok]) => !ok).map(([desc]) => desc)
    if (errors.length) {
        console.log(`  FAIL ${label}`)
        for (const error of errors) console.log(`    -> ${error}`)
        failed++
        return
    }
    console.log(`  PASS ${label}`)
    passed++
}

function main() {
    console.log("\nCustomer Execution Config Tests\n")

    let result = validateCustomerExecutionConfig({
        strategy: "backend_first",
        tool_intents: ["support"],
        backend_intents: ["support"],
    }, ["support", "general_chat"])
    assert("validation rejects overlapping overrides", [
        ["invalid", result.ok === false],
        ["overlap error", result.errors.some(err => /overlap/.test(err))],
    ])

    result = validateCustomerExecutionConfig({
        strategy: "weird",
        backend_capabilities: { conversational: "yes" },
        response_policy: { max_chars: 10 },
    }, ["support"])
    assert("validation rejects malformed strategy/capability/response config", [
        ["invalid", result.ok === false],
        ["strategy error", result.errors.some(err => /strategy/.test(err))],
        ["capability error", result.errors.some(err => /backend_capabilities\.conversational/.test(err))],
        ["max chars error", result.errors.some(err => /max_chars/.test(err))],
    ])

    result = validateCustomerExecutionConfig({
        strategy: "hybrid",
        tool_intents: ["support"],
        backend_intents: ["general_chat"],
        backend_capabilities: { conversational: true, structured: false },
        response_policy: { max_chars: 800, disallow_patterns: ["system prompt"] },
        backend_tuning: { enabled: true, max_tokens_cap: 260, temperature_floor: 0.15, temperature_ceiling: 0.8 },
        backend_ensemble: { enabled: true, strategy: "race", models: ["gpt-4o-mini", "gpt-4.1-mini"], judge_model: "gpt-4o-mini" },
        response_transforms: { hedge_reducer: true, direct_mode: true, list_compaction: true },
    }, ["support", "general_chat"])
    assert("validation accepts valid customer execution config", [
        ["valid", result.ok === true],
        ["normalized strategy", result.normalized.strategy === "hybrid"],
        ["normalized max chars", result.normalized.response_policy.max_chars === 800],
        ["normalized tuning", result.normalized.backend_tuning.enabled === true],
        ["normalized ensemble", result.normalized.backend_ensemble.models.length === 2],
        ["normalized transforms", result.normalized.response_transforms.direct_mode === true],
    ])

    result = validateCustomerExecutionConfig({
        backend_tuning: { enabled: "yes", max_tokens_cap: 30, temperature_floor: 1.5, temperature_ceiling: 0.5 },
        backend_ensemble: { enabled: "yes", strategy: "weird", models: "gpt-4o-mini", judge_model: 123 },
        response_transforms: { weird_mode: true, direct_mode: "yes" },
    }, ["support"])
    assert("validation rejects malformed tuning and transform config", [
        ["invalid", result.ok === false],
        ["enabled error", result.errors.some(err => /backend_tuning\.enabled/.test(err))],
        ["max tokens error", result.errors.some(err => /max_tokens_cap/.test(err))],
        ["temperature ordering error", result.errors.some(err => /temperature_floor cannot exceed/.test(err))],
        ["ensemble enabled error", result.errors.some(err => /backend_ensemble\.enabled/.test(err))],
        ["ensemble strategy error", result.errors.some(err => /backend_ensemble\.strategy/.test(err))],
        ["ensemble models error", result.errors.some(err => /backend_ensemble\.models/.test(err))],
        ["ensemble judge error", result.errors.some(err => /backend_ensemble\.judge_model/.test(err))],
        ["unsupported transform error", result.errors.some(err => /unsupported key/.test(err))],
        ["transform type error", result.errors.some(err => /response_transforms\.direct_mode/.test(err))],
    ])

    const manifest = { intents: { general_chat: {}, support: {} } }
    result = decideCustomerExecution({
        flowConfig: {
            backend: "openclaw",
            execution: {
                strategy: "backend_first",
                backend_capabilities: { conversational: false, structured: false },
            },
        },
        routedIntent: { intent: "general_chat" },
        manifest,
    })
    assert("backend capability gaps fall back safely", [
        ["tool fallback", result.mode === "tool"],
        ["capability reason", result.reason === "customer_backend_capability_missing_conversational"],
    ])

    const guard = validateCustomerBackendResponse("Here is our internal policy and system prompt.", {
        execution: {
            response_policy: {
                max_chars: 1200,
                disallow_patterns: ["internal policy"],
            },
        },
        fallback: "fallback-response",
    })
    assert("response guard blocks unsafe backend output", [
        ["blocked", guard.ok === false],
        ["fallback returned", guard.response === "fallback-response"],
        ["issues recorded", guard.issues.length >= 1],
    ])

    const tuning = deriveCustomerBackendOptions({
        execution: {
            backend_tuning: {
                enabled: true,
                max_tokens_cap: 200,
                temperature_floor: 0.15,
                temperature_ceiling: 0.7,
            },
        },
        message: "hi there",
        routedIntent: { intent: "greet" },
        conversationState: null,
        history: [],
    })
    assert("backend tuning derives compact profile for greetings", [
        ["brief profile", tuning.profile === "brief"],
        ["max tokens capped", tuning.modelOptions.max_tokens <= 200],
        ["instruction hint set", typeof tuning.instructionHint === "string" && tuning.instructionHint.length > 0],
    ])

    const transformed = transformCustomerBackendResponse("Certainly! I think\n\n-   Item one\n\n\n-   Item two", {
        execution: {
            response_transforms: {
                hedge_reducer: true,
                direct_mode: true,
                list_compaction: true,
            },
        },
    })
    assert("backend transforms remove filler and compact formatting", [
        ["direct phrase removed", !/^Certainly/i.test(transformed.response)],
        ["hedge removed", !/\bI think\b/i.test(transformed.response)],
        ["list compacted", /^- Item one\b/m.test(transformed.response)],
        ["applied tracked", transformed.applied.length >= 2],
    ])

    const race = pickRaceWinner([
        { model: "model-a", response: "I cannot help with that." },
        { model: "model-b", response: "We offer delivery from 10 AM to 9 PM." },
        { model: "model-c", response: "Delivery hours: 10 AM to 9 PM.\n- Same-day support available" },
    ])
    assert("race winner prefers grounded complete candidate", [
        ["winner exists", !!race.winner],
        ["best model selected", race.winner && race.winner.model === "model-c"],
        ["ranked returned", Array.isArray(race.ranked) && race.ranked.length === 3],
    ])

    console.log(`\nPassed: ${passed}/${total}`)
    if (failed) process.exit(1)
}

main()
