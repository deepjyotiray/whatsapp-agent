"use strict"

const Database = require("better-sqlite3")

function getDb(dbPath) { return new Database(dbPath, { readonly: true }) }

function searchItems(dbPath, words) {
    const db = getDb(dbPath)
    try {
        const items = db.prepare(`
            SELECT i.name, i.price, i.veg, i.description, i.calories, i.protein,
                   s.title as section
            FROM menu_items i
            JOIN menu_sections s ON s.id = i.section_id
            WHERE i.available = 1 AND s.available = 1
              AND s.menu_type IN ('main','motd')
        `).all()
        return items
            .map(item => {
                const haystack = `${item.name} ${item.description || ""} ${item.section}`.toLowerCase()
                const score = words.reduce((n, w) => n + (haystack.includes(w) ? 1 : 0), 0)
                return { ...item, score }
            })
            .filter(i => i.score > 0)
            .sort((a, b) => b.score - a.score)
    } finally { db.close() }
}

function formatItem(item) {
    const tag = item.veg ? "🟢 Veg" : "🍗 Non-Veg"
    let line = `• ${item.name} — ₹${item.price} [${tag}]`
    if (item.calories) line += ` | ${item.calories} kcal`
    if (item.protein)  line += ` | ${item.protein}g protein`
    return line
}

function extractPriceLimit(raw) {
    const m = raw.match(/(?:under|below|less\s+than|max|upto|up\s+to|within)\s*₹?\s*(\d+)/i)
    return m ? parseInt(m[1]) : null
}

function isVegQuery(words, raw) {
    if (/non.?veg/i.test(raw)) return false
    return words.some(w => ["veg", "vegetarian", "veggie", "plant"].includes(w))
}

function isNonVegQuery(words, raw) {
    if (/non.?veg/i.test(raw)) return true
    return words.some(w => ["nonveg", "chicken", "egg", "fish", "prawn", "meat", "mutton"].includes(w))
}

function isCouponQuery(words) {
    return words.some(w => ["coupon", "discount", "offer", "promo", "deal", "code"].includes(w))
}

function getCoupons(dbPath) {
    const db = getDb(dbPath)
    try {
        const coupons = db.prepare("SELECT code, discount, min_order, free_delivery, is_percent, max_discount, free_delivery_only FROM coupons WHERE active = 1").all()
        if (!coupons.length) return "No active offers right now."
        const lines = ["🎟️ Active Coupons & Offers"]
        for (const c of coupons) {
            if (c.free_delivery_only) lines.push(`• ${c.code} — Free delivery on orders above ₹${c.min_order}`)
            else if (c.is_percent)    lines.push(`• ${c.code} — ${c.discount}% off (max ₹${c.max_discount}) on orders above ₹${c.min_order}`)
            else                      lines.push(`• ${c.code} — ₹${c.discount} off on orders above ₹${c.min_order}`)
        }
        return lines.join("\n")
    } finally { db.close() }
}

function getVegItems(dbPath, veg, maxPrice = null) {
    const db = getDb(dbPath)
    try {
        return db.prepare(`
            SELECT i.name, i.price, i.veg, i.calories, i.protein, s.title as section
            FROM menu_items i
            JOIN menu_sections s ON s.id = i.section_id
            WHERE i.available = 1 AND s.available = 1
              AND s.menu_type IN ('main','motd') AND i.veg = ?
              ${maxPrice !== null ? `AND i.price <= ${maxPrice}` : ""}
            ORDER BY i.price, s.position, i.position
        `).all(veg ? 1 : 0)
    } finally { db.close() }
}

async function retrieveContext(query = "", dbPath, vectordbPath) {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1)

    if (isCouponQuery(words)) return getCoupons(dbPath)

    const maxPrice  = extractPriceLimit(query)
    const priceLabel = maxPrice !== null ? ` under ₹${maxPrice}` : ""

    if (isVegQuery(words, query)) {
        const items = getVegItems(dbPath, true, maxPrice)
        if (!items.length) return `No veg items available${priceLabel} right now.`
        return `🟢 Veg Options${priceLabel}:\n` + items.map(formatItem).join("\n")
    }
    if (isNonVegQuery(words, query)) {
        const items = getVegItems(dbPath, false, maxPrice)
        if (!items.length) return `No non-veg items available${priceLabel} right now.`
        return `🍗 Non-Veg Options${priceLabel}:\n` + items.map(formatItem).join("\n")
    }

    let matched = searchItems(dbPath, words)
    if (maxPrice !== null) matched = matched.filter(i => i.price <= maxPrice)
    if (matched.length && matched.length <= 8) {
        return (matched.length === 1 ? "" : "Here's what I found:\n") + matched.map(formatItem).join("\n")
    }

    // Fallback — vector search
    const lancedb = require("@lancedb/lancedb")
    const vdb   = await lancedb.connect(vectordbPath || "./vectordb")
    const table = await vdb.openTable("restaurant")
    const all   = await table.query().toArray()
    if (!all.length) return "Menu not available."

    let best = all[0], bestScore = -1
    for (const row of all) {
        const kw    = (row.keywords || "").toLowerCase()
        const score = words.reduce((n, w) => n + (kw.includes(w) ? 1 : 0), 0)
        const boost = words.some(w => ["today", "special", "motd"].includes(w)) && kw.includes("today") ? 2 : 0
        if (score + boost > bestScore) { bestScore = score + boost; best = row }
    }
    return String(best.text)
}

module.exports = { retrieveContext }
