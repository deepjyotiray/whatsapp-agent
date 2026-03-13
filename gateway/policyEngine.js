"use strict"

const fs = require("fs")
const yaml = require("js-yaml")

const policy = yaml.load(fs.readFileSync("./policy/policy.yml", "utf8"))

const DOMAIN_KEYWORDS = new Set(policy.domain_keywords.map(k => k.toLowerCase()))

/**
 * @param {{ intent: string, parameters: object }} intent
 * @returns {{ allowed: boolean, reason?: string }}
 */
function evaluate(intent) {
    if (!intent || typeof intent.intent !== "string") {
        return { allowed: false, reason: "malformed_intent" }
    }

    if (intent.intent === "unknown") {
        return { allowed: false, reason: "unknown_intent" }
    }

    if (policy.restricted_intents.includes(intent.intent)) {
        return { allowed: false, reason: "restricted_intent" }
    }

    if (!policy.allowed_intents.includes(intent.intent)) {
        return { allowed: false, reason: "not_in_allowlist" }
    }

    return { allowed: true }
}

/**
 * Checks whether a raw message is within the food/order domain.
 * Used as a pre-parse domain guard.
 * @param {string} message
 * @returns {boolean}
 */
function isInDomain(message) {
    const lower = message.toLowerCase()
    for (const keyword of DOMAIN_KEYWORDS) {
        if (lower.includes(keyword)) return true
    }
    return false
}

module.exports = { evaluate, isInDomain }
