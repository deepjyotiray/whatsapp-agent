"use strict"

const auth = require("../gateway/auth")

/**
 * Handles the login intent.
 * If the user has a pending OTP and their message looks like a 6-digit code, verify it.
 * Otherwise initiate a new OTP.
 *
 * @param {object} params - { otp? }
 * @param {object} context - { phone, rawMessage }
 * @returns {Promise<string>}
 */
async function execute(params, context) {
    const { phone, rawMessage } = context

    // If user submitted a 6-digit code and has a pending OTP
    const otpCandidate = (rawMessage || "").trim()
    if (/^\d{6}$/.test(otpCandidate) && auth.hasPendingOtp(phone)) {
        const result = auth.verifyOtp(phone, otpCandidate)
        if (result.success) return "✅ You are now logged in."
        if (result.reason === "otp_expired") return "OTP expired. Send 'login' to request a new one."
        return "Incorrect OTP. Please try again."
    }

    if (auth.isAuthorized(phone)) {
        return "You are already logged in."
    }

    const otp = auth.initiateLogin(phone)
    // In production: send OTP via SMS or a separate WhatsApp message
    // For now, echo it back (development only)
    return `Your OTP is: ${otp}\nIt expires in 5 minutes. Reply with the 6-digit code to verify.`
}

module.exports = { execute }
