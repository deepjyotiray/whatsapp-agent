"use strict"

const SESSION_TTL_MS = 30 * 60 * 1000  // 30 minutes
const MAX_TURNS = 10                    // keep last 10 exchanges per session

const sessions = {}  // phone -> { history: [{role, text}], expiresAt, lastAgent }

setInterval(() => {
    const now = Date.now()
    for (const phone of Object.keys(sessions)) {
        if (now > sessions[phone].expiresAt) delete sessions[phone]
    }
}, 60_000).unref()

function getHistory(phone) {
    const s = sessions[phone]
    if (!s || Date.now() > s.expiresAt) return []
    return s.history
}

function getLastAgent(phone) {
    const s = sessions[phone]
    if (!s || Date.now() > s.expiresAt) return null
    return s.lastAgent || null
}

function addTurn(phone, userText, agentText, agentName) {
    if (!sessions[phone] || Date.now() > sessions[phone].expiresAt) {
        sessions[phone] = { history: [], expiresAt: Date.now() + SESSION_TTL_MS }
    }
    if (agentName) sessions[phone].lastAgent = agentName
    sessions[phone].history.push({ role: "customer", text: userText })
    if (agentText) sessions[phone].history.push({ role: "agent", text: agentText })
    // Trim to last MAX_TURNS exchanges (each exchange = 2 entries)
    const max = MAX_TURNS * 2
    if (sessions[phone].history.length > max) {
        sessions[phone].history = sessions[phone].history.slice(-max)
    }
    // Refresh TTL on activity
    sessions[phone].expiresAt = Date.now() + SESSION_TTL_MS
}

function clearSession(phone) {
    delete sessions[phone]
}

module.exports = { getHistory, addTurn, clearSession, getLastAgent }
