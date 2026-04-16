"use strict"

const { prepareRequest } = require("./contextPipeline")

const LIGHT_BACKEND_INTENTS = new Set(["greet", "general_chat"])
const _dbContextCache = new Map()
const CACHE_TTL_MS = 30 * 60 * 1000

function normalizeText(value = "") {
    return String(value || "").trim().replace(/\s+/g, " ")
}

function buildTurnText(message, history) {
    const parts = [normalizeText(message)]
    if (Array.isArray(history)) {
        for (const turn of history.slice(-6)) {
            parts.push(normalizeText(turn?.text || ""))
        }
    }
    return parts.filter(Boolean).join("\n").toLowerCase()
}

function projectCustomerProfileForTurn(profile = {}, message = "", history = []) {
    if (!profile || typeof profile !== "object") return profile
    const next = { ...profile }
    const dietaryPreferences = Array.isArray(profile.dietaryPreferences) ? [...profile.dietaryPreferences] : []
    if (!dietaryPreferences.length) return next

    const turnText = buildTurnText(message, history)
    const explicitNonVegSignal = /\b(non[- ]?veg|chicken|mutton|fish|prawn|prawns|egg)\b/.test(turnText)
    if (explicitNonVegSignal) {
        next.dietaryPreferences = dietaryPreferences.filter(value => {
            const normalized = normalizeText(value).toLowerCase()
            return !["vegetarian", "vegan", "jain"].includes(normalized)
        })
    }

    return next
}

function buildProfileFacts(profile = {}) {
    const lines = []
    for (const [k, v] of Object.entries(profile)) {
        if (!v || typeof v !== "string") continue
        if (["openaiKey", "workspaceId", "agentManifest", "domainPack", "scrapeWebsite", "customFields"].includes(k)) continue
        lines.push(`- ${k}: ${v}`)
    }
    const custom = Array.isArray(profile.customFields) ? profile.customFields : []
    for (const field of custom) {
        if (!field?.key || !field?.value) continue
        lines.push(`- ${field.key}: ${field.value}`)
    }
    return lines.join("\n") || "No profile data available."
}

function cacheKey(workspaceId, relevantTables) {
    const tables = Array.isArray(relevantTables) ? [...relevantTables].sort().join(",") : "*"
    return `${workspaceId || "default"}::${tables}`
}

function getCachedContext(workspaceId, relevantTables) {
    const key = cacheKey(workspaceId, relevantTables)
    const cached = _dbContextCache.get(key)
    if (!cached) return null
    if ((Date.now() - cached.ts) > CACHE_TTL_MS) {
        _dbContextCache.delete(key)
        return null
    }
    return cached.value
}

function setCachedContext(workspaceId, relevantTables, value) {
    const key = cacheKey(workspaceId, relevantTables)
    _dbContextCache.set(key, { ts: Date.now(), value })
    return value
}

function buildCustomerBackendMessages({
    message,
    phone,
    manifest,
    profile,
    history,
    conversationState,
    resolvedRequest,
    dbContext,
    schema,
    notes,
    ragHints,
    policyContext,
}) {
    const businessName = profile.businessName || manifest.agent?.name || "the business"
    const projectedCustomerProfile = projectCustomerProfileForTurn(
        conversationState?.customerProfile,
        message,
        history,
    )
    const customerProfileSummary = projectedCustomerProfile
        ? Object.entries(projectedCustomerProfile)
            .filter(([, value]) => value && (!Array.isArray(value) || value.length))
            .map(([key, value]) => `- ${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
            .join("\n")
        : ""
    const policyBlock = policyContext?.blockedReason
        ? `\nPolicy context:
- The customer message was flagged before normal business routing with reason: ${policyContext.blockedReason}.
- The routed intent at the time of the block was: ${policyContext.routedIntent || "general_chat"}.
- Decide the reply yourself.
- If the message is harmless conversational small talk, you may answer briefly and naturally.
- If it is broad or unrelated, decline gently and redirect to what the business can help with.
- Do not claim business capabilities that are not grounded in the provided context.`
        : ""
    const systemContext = `You are the customer-facing assistant for ${businessName}.
Answer using the provided business profile, database context, schema, notes, retrieval hints, and recent conversation history.
If the configured mode is a backend service, keep this request on that backend path.
Be concise, accurate, and helpful for a WhatsApp customer.${policyBlock}`
    const dynamicContext = [
        customerProfileSummary ? `=== CUSTOMER PROFILE MEMORY ===\n${customerProfileSummary}` : "",
        "=== DATABASE CONTEXT ===",
        dbContext,
        "",
        "=== DATABASE SCHEMA ===",
        schema,
        notes ? `\n=== DATA MODEL NOTES ===\n${notes}` : "",
        ragHints ? `\n=== RETRIEVAL HINTS ===\n${ragHints}` : "",
    ].filter(Boolean).join("\n")

    return prepareRequest(`Customer message:\n${message}`, "customer", {
        systemContext,
        profileFacts: buildProfileFacts(profile),
        dynamicContext,
        history,
        conversationState,
        resolvedRequest,
        phone,
    })
}

module.exports = {
    buildProfileFacts,
    buildCustomerBackendMessages,
    LIGHT_BACKEND_INTENTS,
    getCachedContext,
    setCachedContext,
    projectCustomerProfileForTurn,
}
