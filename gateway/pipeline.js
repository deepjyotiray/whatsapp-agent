"use strict"

const { sanitize } = require("./sanitizer")
const { parseIntent } = require("./intentParser")
const { evaluate, isInDomain } = require("./policyEngine")
const { execute } = require("./executor")
const { hasPendingOtp } = require("./auth")
const { isAdmin, parseAdminMessage, handleAdmin } = require("./admin")
const logger = require("./logger")

/**
 * Full secure execution pipeline.
 * Every message must pass all gates before a tool is invoked.
 *
 * @param {string} message - raw user message
 * @param {string} phone   - sender's phone/JID
 * @returns {Promise<string>} - response to send back
 */
async function pipeline(message, phone) {
    // 0. Admin intercept — before all other checks
    if (isAdmin(phone)) {
        const admin = parseAdminMessage(message)
        if (admin.isAdmin) return await handleAdmin(admin.payload)
    }

    // 1. Input Sanitization
    const sanity = sanitize(message)
    if (!sanity.safe) {
        logger.warn({ phone, reason: sanity.reason }, "sanitizer: blocked")
        return "Your message could not be processed."
    }

    // 2. OTP interception — if user has a pending OTP and sends a 6-digit code,
    //    route directly to authTool without touching the LLM
    if (/^\d{6}$/.test(message.trim()) && hasPendingOtp(phone)) {
        logger.info({ phone }, "pipeline: otp reply intercepted")
        return await execute({ intent: "login", parameters: {} }, { phone, rawMessage: message })
    }

    // 3. Domain Confinement — fast-path check before hitting the LLM
    // Single words and short phrases always pass — greetings, commands like "menu", "login"
    const wordCount = message.trim().split(/\s+/).length
    if (wordCount > 3 && !isInDomain(message)) {
        logger.info({ phone, message }, "pipeline: out of domain")
        return "Sorry, I can only help with food orders and menu queries."
    }

    // 4. Intent Parsing (LLM as translator only)
    let intent
    try {
        intent = await parseIntent(message)
    } catch (err) {
        logger.error({ phone, err }, "pipeline: intent parser error")
        return "Something went wrong. Please try again."
    }

    logger.info({ phone, intent }, "pipeline: intent parsed")

    // 5. Policy Evaluation
    const policy = evaluate(intent)
    if (!policy.allowed) {
        logger.warn({ phone, intent: intent.intent, reason: policy.reason }, "pipeline: policy blocked")
        if (policy.reason === "restricted_intent") {
            return "Sorry, I cannot perform that request."
        }
        return "Sorry, I can only help with food orders and menu queries."
    }

    // 6. Tool Execution (deterministic, no LLM involvement)
    try {
        return await execute(intent, { phone, rawMessage: message })
    } catch (err) {
        logger.error({ phone, intent: intent.intent, err }, "pipeline: executor error")
        return "Something went wrong. Please try again."
    }
}

module.exports = { pipeline }
