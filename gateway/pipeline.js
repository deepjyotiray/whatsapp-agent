"use strict"

const { sanitize } = require("./sanitizer")
const { isInDomain } = require("./policyEngine")
const { hasPendingOtp } = require("./auth")
const { isAdmin, parseAdminMessage, handleAdmin } = require("./admin")
const logger = require("./logger")
const agentChain = require("../runtime/agentChain")

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
    const admin = parseAdminMessage(message, phone)
    if (admin.isAdmin) return await handleAdmin(admin.payload, { user: admin.user, flow: admin.flow })
    if (admin.matchedFlow && admin.message) return admin.message

    // 1. Input Sanitization
    const sanity = sanitize(message)
    if (!sanity.safe) {
        logger.warn({ phone, reason: sanity.reason }, "sanitizer: blocked")
        return "Your message could not be processed."
    }

    // 2. OTP interception — if user has a pending OTP and sends a 6-digit code,
    //    route directly through agentChain
    if (/^\d{6}$/.test(message.trim()) && hasPendingOtp(phone)) {
        logger.info({ phone }, "pipeline: otp reply intercepted")
        return await agentChain.execute(message, phone)
    }

    // 3. Domain Confinement — fast-path check before hitting the LLM
    // Single words and short phrases always pass — greetings, commands like "menu", "login"
    const wordCount = message.trim().split(/\s+/).length
    if (wordCount > 3 && !isInDomain(message)) {
        logger.info({ phone, message }, "pipeline: out of domain")
        return "Sorry, that request is outside what I can help with."
    }

    // 4. Route through agentChain
    try {
        return await agentChain.execute(message, phone)
    } catch (err) {
        logger.error({ phone, err }, "pipeline: agentChain error")
        return "Something went wrong. Please try again."
    }
}

module.exports = { pipeline }
