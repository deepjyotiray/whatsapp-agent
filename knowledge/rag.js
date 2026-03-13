"use strict"

const Database = require("better-sqlite3")

const DB_PATH = "/Users/deepjyotiray/Documents/FoodWebsite/ray-orders-backend/orders.db"

function getDb() { return new Database(DB_PATH, { readonly: true }) }

// ── Item-level search ──────────────────────────────────────────────────────

function searchItems(words) {
    const db = getDb()
    try {
        const items = db.prepare(`
            SELECT i.name, i.price, i.veg, i.description, i.calories, i.protein,
                   s.title as section
            FROM menu_items i
            JOIN menu_sections s ON s.id = i.section_id
            WHERE i.available = 1 AND s.available = 1
              AND s.menu_type IN ('main','motd')
        `).all()

        // Score each item against query words
        return items
            .map(item => {
                const haystack = `${item.name} ${item.description || ""} ${item.section}`.toLowerCase()
                const score = words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0)
                return { ...item, score }
            })
            .filter(i => i.score > 0)
            .sort((a, b) => b.score - a.score)
    } finally {
        db.close()
    }
}

function formatItem(item) {
    const tag = item.veg ? "🟢 Veg" : "🍗 Non-Veg"
    let line = `• ${item.name} — ₹${item.price} [${tag}]`
    if (item.calories) line += ` | ${item.calories} kcal`
    if (item.protein) line += ` | ${item.protein}g protein`
    return line
}

// ── Intent-aware query handler ─────────────────────────────────────────────

// Extract price constraint from query: "under 100", "below 150", "less than 200", "max 100"
function extractPriceLimit(raw) {
    const m = raw.match(/(?:under|below|less\s+than|max|upto|up\s+to|within)\s*₹?\s*(\d+)/i)
    return m ? parseInt(m[1]) : null
}

function isVegQuery(words, raw) {
    const r = raw.toLowerCase()
    if (/non.?veg/i.test(r)) return false
    return words.some(w => ["veg", "vegetarian", "veggie", "plant"].includes(w))
}

function isNonVegQuery(words, raw) {
    const r = raw.toLowerCase()
    if (/non.?veg/i.test(r)) return true
    return words.some(w => ["nonveg", "chicken", "egg", "fish", "prawn", "meat", "mutton"].includes(w))
}

function isCouponQuery(words) {
    return words.some(w => ["coupon", "discount", "offer", "promo", "deal", "code"].includes(w))
}

function getCoupons() {
    const db = getDb()
    try {
        const coupons = db.prepare("SELECT code, discount, min_order, free_delivery, is_percent, max_discount, free_delivery_only FROM coupons WHERE active = 1").all()
        if (!coupons.length) return "No active offers right now."
        const lines = ["🎟️ Active Coupons & Offers"]
        for (const c of coupons) {
            if (c.free_delivery_only) lines.push(`• ${c.code} — Free delivery on orders above ₹${c.min_order}`)
            else if (c.is_percent) lines.push(`• ${c.code} — ${c.discount}% off (max ₹${c.max_discount}) on orders above ₹${c.min_order}`)
            else lines.push(`• ${c.code} — ₹${c.discount} off on orders above ₹${c.min_order}`)
        }
        return lines.join("\n")
    } finally {
        db.close()
    }
}

function getVegItems(veg, maxPrice = null) {
    const db = getDb()
    try {
        const sql = `
            SELECT i.name, i.price, i.veg, i.calories, i.protein, s.title as section
            FROM menu_items i
            JOIN menu_sections s ON s.id = i.section_id
            WHERE i.available = 1 AND s.available = 1
              AND s.menu_type IN ('main','motd') AND i.veg = ?
              ${maxPrice !== null ? `AND i.price <= ${maxPrice}` : ""}
            ORDER BY i.price, s.position, i.position
        `
        return db.prepare(sql).all(veg ? 1 : 0)
    } finally {
        db.close()
    }
}

// ── Main entry ─────────────────────────────────────────────────────────────

async function retrieveContext(query = "") {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1)

    // Coupon query
    if (isCouponQuery(words)) return getCoupons()

    // Veg / Non-veg filter
    const maxPrice = extractPriceLimit(query)
    const priceLabel = maxPrice !== null ? ` under ₹${maxPrice}` : ""

    if (isVegQuery(words, query)) {
        const items = getVegItems(true, maxPrice)
        if (!items.length) return `No veg items available${priceLabel} right now.`
        return `🟢 Veg Options${priceLabel}:\n` + items.map(formatItem).join("\n")
    }
    if (isNonVegQuery(words, query)) {
        const items = getVegItems(false, maxPrice)
        if (!items.length) return `No non-veg items available${priceLabel} right now.`
        return `🍗 Non-Veg Options${priceLabel}:\n` + items.map(formatItem).join("\n")
    }

    // Item-level search with optional price filter
    let matched = searchItems(words)
    if (maxPrice !== null) matched = matched.filter(i => i.price <= maxPrice)
    if (matched.length) {
        if (matched.length <= 8) return (matched.length === 1 ? "" : "Here's what I found:\n") + matched.map(formatItem).join("\n")
    }

    // Fallback — return full menu section most relevant to query
    const lancedb = require("@lancedb/lancedb")
    const db = await lancedb.connect("./vectordb")
    const table = await db.openTable("restaurant")
    const all = await table.query().toArray()
    if (!all.length) return "Menu not available."

    let best = all[0], bestScore = -1
    for (const row of all) {
        const kw = (row.keywords || "").toLowerCase()
        const score = words.reduce((n, w) => n + (kw.includes(w) ? 1 : 0), 0)
        const todayBoost = words.some(w => ["today", "special", "motd"].includes(w)) && kw.includes("today") ? 2 : 0
        if (score + todayBoost > bestScore) { bestScore = score + todayBoost; best = row }
    }
    return String(best.text)
}

module.exports = { retrieveContext }
