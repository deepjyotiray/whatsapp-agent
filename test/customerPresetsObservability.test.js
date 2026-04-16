"use strict"

const { listCustomerBackendPresets, getCustomerBackendPreset } = require("../runtime/customerBackendPresets")
const { summarizeCustomerLog } = require("../runtime/customerObservability")

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
    console.log("\nCustomer Presets & Observability Tests\n")

    const presets = listCustomerBackendPresets()
    assert("customer backend presets are available", [
        ["has openclaw preset", presets.some(p => p.id === "openclaw")],
        ["has myclaw preset", presets.some(p => p.id === "myclaw")],
        ["has nemoclaw preset", presets.some(p => p.id === "nemoclaw")],
        ["has godmod3 preset", presets.some(p => p.id === "godmod3")],
    ])

    const preset = getCustomerBackendPreset("myclaw")
    assert("preset lookup returns normalized execution config", [
        ["preset found", !!preset],
        ["strategy present", preset && preset.execution && typeof preset.execution.strategy === "string"],
        ["response policy present", preset && preset.execution && preset.execution.response_policy && typeof preset.execution.response_policy.max_chars === "number"],
        ["backend tuning present", preset && preset.execution && preset.execution.backend_tuning && typeof preset.execution.backend_tuning.enabled === "boolean"],
        ["response transforms present", preset && preset.execution && preset.execution.response_transforms && typeof preset.execution.response_transforms.direct_mode === "boolean"],
    ])

    const summary = summarizeCustomerLog([
        { intent: "customer_backend", phone: "+1", ts: 1, preview: { strategy: "backend_first", backend: "openclaw", tuningProfile: "precise", responseTransforms: ["direct_mode"], responseGuardIssues: [] } },
        { intent: "customer_tool", phone: "+2", ts: 2, preview: { strategy: "tool_first", backend: "direct" } },
        { intent: "policy_blocked", phone: "+3", ts: 3, preview: { strategy: "auto", reason: "out_of_domain" } },
        { intent: "customer_backend", phone: "+4", ts: 4, preview: { strategy: "auto", backend: "myclaw", tuningProfile: "brief", responseTransforms: ["hedge_reducer", "direct_mode"], ensembleStrategy: "race", ensembleWinner: "gpt-4.1-mini", ensembleCandidates: [{ model: "gpt-4o-mini" }, { model: "gpt-4.1-mini" }], responseGuardIssues: ["response_too_long"] } },
    ])
    assert("observability summary aggregates customer runtime signals", [
        ["total counted", summary.total === 4],
        ["policy blocks counted", summary.policyBlocks === 1],
        ["guard hits counted", summary.backendGuardHits === 1],
        ["ensemble runs counted", summary.backendEnsembleRuns === 1],
        ["routes aggregated", summary.byRoute.customer_backend === 2],
        ["strategies aggregated", summary.byStrategy.auto === 2],
        ["tuning profiles aggregated", summary.byTuningProfile.brief === 1 && summary.byTuningProfile.precise === 1],
        ["recent tuning tracked", summary.recent[0].tuningProfile === "brief"],
        ["recent transforms tracked", Array.isArray(summary.recent[0].responseTransforms) && summary.recent[0].responseTransforms.length === 2],
        ["recent ensemble tracked", summary.recent[0].ensembleStrategy === "race" && summary.recent[0].ensembleWinner === "gpt-4.1-mini"],
    ])

    console.log(`\nPassed: ${passed}/${total}`)
    if (failed) process.exit(1)
}

main()
