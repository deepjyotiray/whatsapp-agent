"use strict"

const { normalizeCustomerExecutionConfig } = require("./customerExecutionConfig")

const UNSAFE_HINTS = /\b(system prompt|internal policy|hidden instructions)\b/i

function scoreCandidate(text = "") {
    const normalized = String(text || "").trim()
    if (!normalized) return -100
    let score = 0
    const length = normalized.length

    score += Math.min(length, 500) / 25
    if (length < 40) score -= 6
    if (length > 900) score -= Math.min(18, Math.floor((length - 900) / 80) + 2)
    if (UNSAFE_HINTS.test(normalized)) score -= 40
    if (/\b(i cannot|i can't|i am unable|i'm unable)\b/i.test(normalized)) score -= 12
    if (/\n- /.test(normalized) || /\n\d+\. /.test(normalized)) score += 2
    if (/[.!?]$/.test(normalized)) score += 1

    return score
}

function pickRaceWinner(candidates = []) {
    const scored = candidates.map(candidate => ({
        ...candidate,
        score: scoreCandidate(candidate.response),
    }))
    scored.sort((a, b) => b.score - a.score)
    return {
        winner: scored[0] || null,
        ranked: scored,
    }
}

function buildConsensusMessages(messages = [], candidates = []) {
    const priorTurn = Array.isArray(messages)
        ? messages.filter(msg => msg && msg.content != null).map(msg => ({
            role: msg.role || "user",
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        }))
        : []

    const candidateBlock = candidates
        .map((candidate, index) => `Candidate ${index + 1} (${candidate.model}):\n${candidate.response}`)
        .join("\n\n")

    return [
        {
            role: "system",
            content: "You are synthesizing multiple candidate answers for a customer-facing business assistant. Produce one grounded, concise, natural response. Prefer the most accurate and actionable details. Do not mention candidates, voting, or internal selection.",
        },
        ...priorTurn,
        {
            role: "user",
            content: `Synthesize the best final answer from these candidate responses:\n\n${candidateBlock}`,
        },
    ]
}

function ensembleSupported(flowCfg = {}) {
    const backend = String(flowCfg.backend || "direct")
    return !["openclaw", "myclaw", "nemoclaw"].includes(backend)
}

async function runCustomerBackendEnsemble({ messages, flowCfg, complete, baseOptions = {} }) {
    const execution = normalizeCustomerExecutionConfig(flowCfg.execution || {})
    const ensemble = execution.backend_ensemble || {}
    const models = Array.isArray(ensemble.models) ? ensemble.models.filter(Boolean) : []

    if (!ensemble.enabled || models.length < 2 || !ensembleSupported(flowCfg)) {
        return { used: false }
    }

    const completions = await Promise.all(models.map(async (model) => {
        try {
            const response = await complete(messages, {
                ...baseOptions,
                model,
            })
            return {
                model,
                response: String(response || "").trim(),
                ok: true,
            }
        } catch (err) {
            return {
                model,
                response: "",
                ok: false,
                error: err?.message || "ensemble_candidate_failed",
            }
        }
    }))

    const successful = completions.filter(candidate => candidate.ok && candidate.response)
    if (!successful.length) {
        return {
            used: true,
            strategy: ensemble.strategy,
            candidates: completions.map(({ model, ok, error }) => ({ model, ok, error: error || null })),
            response: "",
            winner: null,
        }
    }

    if (ensemble.strategy === "consensus" && successful.length >= 2) {
        const judgeModel = ensemble.judge_model || models[0]
        try {
            const consensusMessages = buildConsensusMessages(messages, successful)
            const response = await complete(consensusMessages, {
                ...baseOptions,
                model: judgeModel,
            })
            return {
                used: true,
                strategy: "consensus",
                response: String(response || "").trim(),
                winner: judgeModel,
                candidates: completions.map(({ model, ok, error }) => ({ model, ok, error: error || null })),
            }
        } catch {
            // Fall through to race winner if synthesis fails.
        }
    }

    const race = pickRaceWinner(successful)
    return {
        used: true,
        strategy: "race",
        response: race.winner?.response || "",
        winner: race.winner?.model || null,
        candidates: race.ranked.map(({ model, score, ok }) => ({ model, score, ok })),
    }
}

module.exports = {
    scoreCandidate,
    pickRaceWinner,
    runCustomerBackendEnsemble,
}
