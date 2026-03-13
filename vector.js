"use strict"

const Database = require("better-sqlite3")
const lancedb = require("@lancedb/lancedb")

const DB_PATH = "/Users/deepjyotiray/Documents/FoodWebsite/ray-orders-backend/orders.db"
const VECTOR_DIM = 384

function buildChunks(db) {
    const chunks = []

    // ── Menu sections + items ──────────────────────────────────────────────
    const sections = db.prepare(`
        SELECT s.id, s.section_key, s.title, s.menu_type
        FROM menu_sections s
        WHERE s.available = 1 AND s.menu_type IN ('main', 'motd')
        ORDER BY s.menu_type, s.position
    `).all()

    for (const section of sections) {
        const items = db.prepare(`
            SELECT name, price, veg, description, calories, protein
            FROM menu_items
            WHERE section_id = ? AND available = 1
            ORDER BY position
        `).all(section.id)

        if (!items.length) continue

        const lines = [`${section.title} (${section.menu_type === "motd" ? "Today's Special" : "Menu"})`]
        for (const item of items) {
            const tag = item.veg ? "🟢 Veg" : "🍗 Non-Veg"
            let line = `• ${item.name} — ₹${item.price} [${tag}]`
            if (item.calories) line += ` | ${item.calories} kcal`
            if (item.protein) line += ` | ${item.protein}g protein`
            if (item.description) line += `\n  ${item.description}`
            lines.push(line)
        }

        chunks.push({
            id: `section_${section.id}`,
            type: "menu",
            keywords: [section.section_key, section.title, ...items.map(i => i.name)].join(" ").toLowerCase(),
            text: lines.join("\n")
        })
    }

    // ── Coupons ────────────────────────────────────────────────────────────
    const coupons = db.prepare(`
        SELECT code, discount, min_order, free_delivery, is_percent, max_discount, free_delivery_only
        FROM coupons WHERE active = 1
    `).all()

    if (coupons.length) {
        const lines = ["🎟️ Active Coupons & Offers"]
        for (const c of coupons) {
            if (c.free_delivery_only) {
                lines.push(`• ${c.code} — Free delivery on orders above ₹${c.min_order}`)
            } else if (c.is_percent) {
                lines.push(`• ${c.code} — ${c.discount}% off (max ₹${c.max_discount}) on orders above ₹${c.min_order}`)
            } else {
                lines.push(`• ${c.code} — ₹${c.discount} off on orders above ₹${c.min_order}`)
            }
        }
        chunks.push({
            id: "coupons",
            type: "coupons",
            keywords: "coupon discount offer promo code deal",
            text: lines.join("\n")
        })
    }

    // ── General info ───────────────────────────────────────────────────────
    chunks.push({
        id: "general",
        type: "info",
        keywords: "order place how website delivery contact",
        text: `Ray's Home Kitchen — Fresh home-cooked meals delivered to you.\n\nTo place an order visit: https://healthymealspot.com\nFor help, reply with "help" or "menu".`
    })

    return chunks
}

async function seed() {
    const db = new Database(DB_PATH, { readonly: true })
    const chunks = buildChunks(db)
    db.close()

    console.log(`Built ${chunks.length} knowledge chunks`)

    const ldb = await lancedb.connect("./vectordb")

    // Drop existing table and recreate
    try { await ldb.dropTable("restaurant") } catch {}

    const rows = chunks.map(c => ({
        vector: new Array(VECTOR_DIM).fill(0),
        id: c.id,
        type: c.type,
        keywords: c.keywords,
        text: c.text
    }))

    await ldb.createTable("restaurant", rows)
    console.log(`✅ Loaded ${rows.length} chunks into vectordb/restaurant`)
    chunks.forEach(c => console.log(` - [${c.type}] ${c.id}`))
}

seed().catch(err => { console.error(err); process.exit(1) })
