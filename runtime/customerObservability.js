"use strict"

function summarizeCustomerLog(log = []) {
    const customerEntries = (log || []).filter(entry => {
        const intent = String(entry.intent || "")
        return intent.startsWith("customer") || intent === "policy_blocked"
    })

    const summary = {
        total: customerEntries.length,
        byRoute: {},
        byStrategy: {},
        byTuningProfile: {},
        policyBlocks: 0,
        backendGuardHits: 0,
        backendEnsembleRuns: 0,
        recent: [],
    }

    for (const entry of customerEntries) {
        const route = String(entry.intent || "unknown")
        summary.byRoute[route] = (summary.byRoute[route] || 0) + 1

        const meta = entry.preview || {}
        const strategy = meta.strategy || "unknown"
        summary.byStrategy[strategy] = (summary.byStrategy[strategy] || 0) + 1
        const tuningProfile = meta.tuningProfile || "none"
        summary.byTuningProfile[tuningProfile] = (summary.byTuningProfile[tuningProfile] || 0) + 1

        if (route === "policy_blocked") summary.policyBlocks++
        if (Array.isArray(meta.responseGuardIssues) && meta.responseGuardIssues.length) summary.backendGuardHits++
        if (meta.ensembleStrategy) summary.backendEnsembleRuns++

        summary.recent.push({
            ts: entry.ts,
            phone: entry.phone,
            route,
            strategy,
            reason: meta.reason || meta.policy || null,
            backend: meta.backend || null,
            tuningProfile: meta.tuningProfile || null,
            responseTransforms: meta.responseTransforms || [],
            ensembleStrategy: meta.ensembleStrategy || null,
            ensembleWinner: meta.ensembleWinner || null,
            ensembleCandidates: meta.ensembleCandidates || [],
            guardIssues: meta.responseGuardIssues || [],
        })
    }

    summary.recent = summary.recent.slice(-20).reverse()
    return summary
}

module.exports = {
    summarizeCustomerLog,
}
