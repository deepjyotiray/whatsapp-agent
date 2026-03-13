"use strict"

const settings = require("../config/settings.json")

const SESSION_TTL_MS = 15 * 60 * 1000  // 15 minutes

// In-memory stores
const pendingOtps = {}   // phone -> { otp, expiresAt }
const sessions = {}      // phone -> { authorizedAt, expiresAt }

// Sweep expired sessions every minute
setInterval(() => {
    const now = Date.now()
    for (const phone of Object.keys(sessions)) {
        if (now > sessions[phone].expiresAt) delete sessions[phone]
    }
    for (const phone of Object.keys(pendingOtps)) {
        if (now > pendingOtps[phone].expiresAt) delete pendingOtps[phone]
    }
}, 60_000).unref()

function generateOtp() {
    return String(Math.floor(100000 + Math.random() * 900000))
}

function initiateLogin(phone) {
    const otp = generateOtp()
    pendingOtps[phone] = { otp, expiresAt: Date.now() + settings.otp.ttlSeconds * 1000 }
    return otp
}

function verifyOtp(phone, submittedOtp) {
    const record = pendingOtps[phone]
    if (!record) return { success: false, reason: "no_pending_otp" }
    if (Date.now() > record.expiresAt) {
        delete pendingOtps[phone]
        return { success: false, reason: "otp_expired" }
    }
    if (record.otp !== submittedOtp) return { success: false, reason: "otp_mismatch" }

    delete pendingOtps[phone]
    sessions[phone] = { authorizedAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS }
    return { success: true }
}

function isAuthorized(phone) {
    const s = sessions[phone]
    if (!s) return false
    if (Date.now() > s.expiresAt) { delete sessions[phone]; return false }
    return true
}

function hasPendingOtp(phone) {
    const record = pendingOtps[phone]
    return Boolean(record && Date.now() <= record.expiresAt)
}

module.exports = { initiateLogin, verifyOtp, isAuthorized, hasPendingOtp }
