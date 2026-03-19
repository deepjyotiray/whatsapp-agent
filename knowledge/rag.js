"use strict"

const Database = require("better-sqlite3")

function getDb(dbPath) {
    const db = new Database(dbPath, { readonly: true })
    db.pragma("busy_timeout = 5000")
    return db
}

function formatItem(item) {
    const tag = item.veg ? "🟢 Veg" : "🍗 Non-Veg"
    let line = `• ${item.name} — ₹${item.price} [${tag}]`
    if (item.calories) line += ` | ${item.calories} kcal`
    if (item.protein)  line += ` | ${item.protein}g protein`
    return line
}

function groupBySection(items) {
    const bySection = {}
    for (const item of items) {
        if (!bySection[item.section]) bySection[item.section] = []
        bySection[item.section].push(item)
    }
    return Object.entries(bySection)
        .map(([sec, its]) => `*${sec}*\n` + its.map(formatItem).join("\n"))
        .join("\n\n")
}

function getCoupons(dbPath) {
    const db = getDb(dbPath)
    try {
        const rows = db.prepare("SELECT code, discount, min_order, is_percent, max_discount, free_delivery_only FROM coupons WHERE active = 1").all()
        if (!rows.length) return "No active offers right now."
        const lines = ["🎟️ Active Coupons & Offers"]
        for (const c of rows) {
            if (c.free_delivery_only) lines.push(`• ${c.code} — Free delivery on orders above ₹${c.min_order}`)
            else if (c.is_percent)    lines.push(`• ${c.code} — ${c.discount}% off (max ₹${c.max_discount}) on orders above ₹${c.min_order}`)
            else                      lines.push(`• ${c.code} — ₹${c.discount} off on orders above ₹${c.min_order}`)
        }
        return lines.join("\n")
    } finally { db.close() }
}

// Score an item name against a query — phrase match scores higher than individual words
function scoreItem(name, desc, phrase, words) {
    const n = name.toLowerCase()
    const d = (desc || "").toLowerCase()
    let score = 0
    if (phrase && n.includes(phrase)) score += 4          // full phrase in name
    if (phrase && d.includes(phrase)) score += 2          // full phrase in description
    for (const w of words) {
        if (n.includes(w)) score += 2                     // individual word in name
        else if (d.includes(w)) score += 1               // individual word in description
    }
    return score
}

function inferSection(db, words, section) {
    if (section || !words.length) return null
    const STOP_WORDS = new Set(["show", "me", "the", "any", "do", "you", "have", "what", "is", "are", "items", "dishes", "options", "food", "anything", "in", "under", "below", "above", "give", "list", "all", "your", "our", "menu", "available"])
    const GENERIC_CATEGORY_WORDS = new Set(["dish", "dishes", "items", "options", "section", "category", "foods", "food"])
    const queryTokens = words.filter(w => !STOP_WORDS.has(w))
    if (!queryTokens.length) return null

    const sections = db.prepare(`
        SELECT title
        FROM menu_sections
        WHERE available = 1
          AND menu_type IN ('main','motd')
          AND section_key NOT IN ('healthySubs')
        ORDER BY position
    `).all()

    let best = null
    let bestScore = 0
    for (const row of sections) {
        const titleTokens = String(row.title)
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter(Boolean)
        const score = queryTokens.reduce((sum, token) => sum + (titleTokens.includes(token) ? 1 : 0), 0)
        if (score > bestScore) {
            bestScore = score
            best = row.title
        }
    }

    const hasGenericCategoryWord = words.some(w => GENERIC_CATEGORY_WORDS.has(w))
    if (bestScore >= 2) return best
    if (bestScore >= 1 && (hasGenericCategoryWord || queryTokens.length === 1)) return best
    return null
}

async function retrieveContext(query = "", dbPath, vectordbPath, filter = {}) {
    const db = getDb(dbPath)
    try {
        let { section } = filter || {}
        const { veg, query: fq, max_price } = filter || {}  // nutrition fields read directly from filter below
        const rawQuery = (fq || "").trim()   // use OpenAI-extracted food query, not raw user message
        const phrase   = rawQuery.toLowerCase()
        const words    = phrase.split(/\s+/).filter(w => w.length > 1)
        const STOP_WORDS = new Set(["show","me","the","any","do","you","have","what","is","are","items","dishes","options","food","anything","in","under","below","above","give","list","all","your","our","menu","available"])
        const foodWords    = words.filter(w => !STOP_WORDS.has(w))
        section = inferSection(db, words, section) || section
        // Enable text scoring when: no section set, OR both section and a food query are set
        const hasTextQuery = foodWords.length > 0 && (!section || (section && fq && fq.trim().length > 0))

        // Coupon query
        if (words.some(w => ["coupon", "discount", "offer", "promo", "deal", "code"].includes(w))) {
            db.close()
            return getCoupons(dbPath)
        }

        let sql = `
            SELECT i.name, i.price, i.veg, i.description, i.calories, i.protein, s.title as section
            FROM menu_items i
            JOIN menu_sections s ON s.id = i.section_id
            WHERE i.available = 1 AND s.available = 1
              AND s.menu_type IN ('main','motd')
              AND s.section_key NOT IN ('healthySubs')
        `
        const params = []

        if (section)              { sql += ` AND s.title = ?`;      params.push(section) }
        if (veg === true)            sql += ` AND i.veg = 1`
        if (veg === false)           sql += ` AND i.veg = 0`
        if (max_price != null)     { sql += ` AND i.price <= ?`;     params.push(max_price) }
        if (filter.max_calories != null) { sql += ` AND i.calories > 0 AND i.calories <= ?`; params.push(filter.max_calories) }
        if (filter.min_protein  != null) { sql += ` AND i.protein >= ?`;  params.push(filter.min_protein) }
        if (filter.max_fat      != null) { sql += ` AND i.fat <= ?`;      params.push(filter.max_fat) }
        if (filter.min_carbs    != null) { sql += ` AND i.carbs >= ?`;    params.push(filter.min_carbs) }

        sql += ` ORDER BY s.position, i.position`

        let items = db.prepare(sql).all(...params)

        // Text scoring — only when there's a meaningful query beyond the section name
        if (hasTextQuery && foodWords.length) {
            items = items
                .map(i => ({ ...i, score: scoreItem(i.name, i.description, phrase, foodWords) }))
                .filter(i => i.score > 0)
                .sort((a, b) => b.score - a.score)

            // If any item matched the full phrase or name, drop description-only matches
            const topScore = items[0]?.score || 0
            if (topScore >= 4) items = items.filter(i => i.score >= 4)
            else if (topScore >= 2) items = items.filter(i => i.score >= 2)
        }

        if (!items.length) return "Sorry, nothing matched that on our menu."
        return groupBySection(items)
    } finally {
        try { db.close() } catch {}
    }
}

module.exports = { retrieveContext }
