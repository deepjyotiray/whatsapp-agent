"use strict"

const TTL = 30 * 60 * 1000

const carts = {}

setInterval(() => {
    const now = Date.now()
    for (const k of Object.keys(carts)) {
        if (now > carts[k].expiresAt) delete carts[k]
    }
}, 60_000).unref()

function get(phone) {
    const c = carts[phone]
    if (!c || Date.now() > c.expiresAt) return null
    return c
}

function set(phone, data) {
    carts[phone] = { ...data, expiresAt: Date.now() + TTL }
}

function update(phone, patch) {
    const c = get(phone)
    if (!c) return
    set(phone, { ...c, ...patch })
}

function clear(phone) {
    delete carts[phone]
}

function clearAll() {
    for (const key of Object.keys(carts)) {
        delete carts[key]
    }
}

// Generic session state store — domain packs define their own state machines
function init(phone) {
    set(phone, { state: "active", data: {}, user: null })
}

module.exports = { get, set, update, clear, clearAll, init }
