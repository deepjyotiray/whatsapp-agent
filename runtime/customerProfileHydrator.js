"use strict"

const Database = require("better-sqlite3")

const CACHE_TTL_MS = 60 * 1000
const _cache = new Map()

function normalizePhone(phone) {
    const digits = String(phone || "").replace(/@.*$/, "").replace(/\D/g, "")
    if (digits.length > 10) return digits.slice(-10)
    return digits
}

function cacheKey(workspaceId, phone, dbPath) {
    return `${workspaceId || "default"}::${normalizePhone(phone)}::${dbPath || ""}`
}

function getCached(workspaceId, phone, dbPath) {
    const key = cacheKey(workspaceId, phone, dbPath)
    const cached = _cache.get(key)
    if (!cached) return null
    if ((Date.now() - cached.ts) > CACHE_TTL_MS) {
        _cache.delete(key)
        return null
    }
    return cached.value
}

function setCached(workspaceId, phone, dbPath, value) {
    const key = cacheKey(workspaceId, phone, dbPath)
    _cache.set(key, { ts: Date.now(), value })
    return value
}

function sanitizeText(value = "", maxLength = 180) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength)
}

function getTableColumns(db, table) {
    try {
        return db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)
    } catch {
        return []
    }
}

function hasTable(db, table) {
    try {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(table)
        return !!row
    } catch {
        return false
    }
}

function firstPresent(record, fields) {
    for (const field of fields) {
        const value = record?.[field]
        if (value !== undefined && value !== null && String(value).trim()) return value
    }
    return null
}

function buildPhonePredicate(columns) {
    const phoneColumns = ["mobile", "phone", "customer_phone", "mobile_number", "contact_phone"].filter(col => columns.includes(col))
    if (!phoneColumns.length) return null
    return {
        clause: phoneColumns.map(col => `${col} LIKE ?`).join(" OR "),
        params: phoneColumns.map(() => `%${"%PHONE%"}`),
    }
}

function preparePhoneQuery(columns, phone) {
    const digits = normalizePhone(phone)
    if (!digits) return null
    const predicate = buildPhonePredicate(columns)
    if (!predicate) return null
    return {
        clause: predicate.clause,
        params: predicate.params.map(() => `%${digits}`),
    }
}

function loadUserProfile(db, phone) {
    if (!hasTable(db, "users")) return null
    const columns = getTableColumns(db, "users")
    const phoneQuery = preparePhoneQuery(columns, phone)
    if (!phoneQuery) return null
    try {
        const row = db.prepare(`SELECT * FROM users WHERE ${phoneQuery.clause} ORDER BY rowid DESC LIMIT 1`).get(...phoneQuery.params)
        if (!row) return null
        return {
            phone: normalizePhone(phone),
            name: sanitizeText(firstPresent(row, ["name", "customer_name", "full_name"]), 60) || null,
            preferredName: sanitizeText(firstPresent(row, ["preferred_name", "nickname"]), 60) || null,
            address: sanitizeText(firstPresent(row, ["address", "delivery_address", "customer_address"]), 180) || null,
            email: sanitizeText(firstPresent(row, ["email", "customer_email"]), 120) || null,
        }
    } catch {
        return null
    }
}

function loadRecentOrderProfile(db, phone) {
    if (!hasTable(db, "orders")) return null
    const columns = getTableColumns(db, "orders")
    const phoneQuery = preparePhoneQuery(columns, phone)
    if (!phoneQuery) return null
    try {
        const row = db.prepare(`SELECT * FROM orders WHERE ${phoneQuery.clause} ORDER BY rowid DESC LIMIT 1`).get(...phoneQuery.params)
        if (!row) return null
        return {
            phone: normalizePhone(phone),
            name: sanitizeText(firstPresent(row, ["customer", "customer_name", "name", "order_for"]), 60) || null,
            address: sanitizeText(firstPresent(row, ["address", "delivery_address", "customer_address"]), 180) || null,
            lastOrderId: sanitizeText(firstPresent(row, ["id", "order_id"]), 80) || null,
        }
    } catch {
        return null
    }
}

function compactProfile(profile = {}) {
    return Object.fromEntries(
        Object.entries(profile).filter(([, value]) => {
            if (value === undefined || value === null) return false
            if (Array.isArray(value)) return value.length > 0
            return String(value).trim() !== ""
        })
    )
}

function hydrateCustomerProfile({ workspaceId, phone, dbPath } = {}) {
    if (!dbPath || !phone) return {}
    const cached = getCached(workspaceId, phone, dbPath)
    if (cached) return { ...cached }

    let db
    try {
        db = new Database(dbPath, { readonly: true })
        db.pragma("busy_timeout = 5000")
        const merged = {
            ...compactProfile(loadRecentOrderProfile(db, phone) || {}),
            ...compactProfile(loadUserProfile(db, phone) || {}),
        }
        return { ...setCached(workspaceId, phone, dbPath, merged) }
    } catch {
        return {}
    } finally {
        try { db?.close() } catch {}
    }
}

function clearHydratedCustomerProfileCache() {
    _cache.clear()
}

module.exports = {
    hydrateCustomerProfile,
    clearHydratedCustomerProfileCache,
    normalizePhone,
}
