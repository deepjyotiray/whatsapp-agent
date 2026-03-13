"use strict"

const fs = require("fs")
const Database = require("better-sqlite3")
const { buildFramedQr } = require("./buildQr")
const settings = require("../config/settings.json")

const AGENT_URL    = `http://127.0.0.1:${settings.api.port}/send`
const AGENT_SECRET = settings.api.secret

function getDb(dbPath) { return new Database(dbPath, { readonly: true }) }

function normalisePhone(phone) {
    return String(phone).replace(/@.*$/, "").replace(/\D/g, "").slice(-10)
}

function isRegistered(dbPath, last10) {
    const db = getDb(dbPath)
    try {
        return !!db.prepare("SELECT id FROM users WHERE mobile LIKE ?").get(`%${last10}`)
    } finally { db.close() }
}

function getPendingOrders(dbPath, last10) {
    const db = getDb(dbPath)
    try {
        return db.prepare(`
            SELECT id, order_for, items, total, status,
                   payment_status, delivery_status, expected_delivery, customer_message
            FROM orders
            WHERE phone LIKE ?
              AND delivery_status NOT IN ('Delivered', 'Cancelled')
            ORDER BY created_at DESC LIMIT 3
        `).all(`%${last10}`)
    } finally { db.close() }
}

const DELIVERY_STATUS_MSG = {
    Confirmed:           "✅ Your order is confirmed and will be delivered by",
    Preparing:           "👨🍳 Your order is being prepared and will be ready by",
    "Out for Delivery":  "🛵 Your order is out for delivery! Expected by",
    Pending:             "⏳ Your order is pending confirmation. Expected delivery by",
}

function deliveryFocus(o) {
    const status = o.delivery_status || o.status || "Pending"
    const prefix = DELIVERY_STATUS_MSG[status] || `📦 Status: ${status}. Expected by`
    return `${prefix} ${o.expected_delivery || "TBD"}.\n🧾 Order: ${o.id}`
}

function paymentFocus(o) {
    const paid = (o.payment_status || "").toLowerCase()
    if (paid === "paid") return `✅ Payment received for order ${o.id}.`
    return `💳 Payment for order ${o.id} is *${o.payment_status || "Pending"}*.\nTotal: ₹${o.total}`
}

function formatOrder(o) {
    return [
        `🧾 Order ID: ${o.id}`,
        `📅 For: ${o.order_for}  ⏰ By: ${o.expected_delivery || "TBD"}`,
        `📦 Delivery: ${o.delivery_status || o.status}`,
        `💳 Payment: ${o.payment_status || o.status}`,
        `\n🛒 Items:\n${o.items}`,
        `\n💰 Total: ₹${o.total}`
    ].join("\n")
}

function detectFocus(msg) {
    const m = msg.toLowerCase()
    if (/deliver|when|arriv|reach|time|how long/.test(m)) return "delivery"
    if (/invoice|receipt|bill|qr|upi|link|resend|proof/.test(m)) return "invoice"
    if (/pay|paid|payment|unpaid|due|amount|total|charge/.test(m)) return "payment"
    return "full"
}

function formatPhone(rawPhone, countryCode = "91") {
    const digits = rawPhone.replace(/@.*$/, "").replace(/\D/g, "")
    const local10 = digits.slice(-10)
    return `+${countryCode}${local10}`
}

async function execute(_params, context, toolConfig) {
    const { db_path, upi_handle, website, country_code = "91", brand_label } = toolConfig
    const last10 = normalisePhone(context.phone)

    if (!isRegistered(db_path, last10)) {
        return `It looks like you're not registered yet.\nSign up at 👇\nhttps://${website}/login`
    }

    const orders = getPendingOrders(db_path, last10)

    if (!orders.length) {
        return `You have no active orders right now.\nVisit https://${website} to place one! 🍽️`
    }

    const focus = detectFocus(context.rawMessage || "")

    if (focus === "delivery") return orders.map(o => deliveryFocus(o)).join("\n\n")

    if (focus === "invoice") {
        const to = formatPhone(context.phone, country_code)
        const results = await Promise.allSettled(orders.map(async o => {
            const msg = o.customer_message
            if (!msg) return paymentFocus(o)
            if ((o.payment_status || "").toLowerCase() === "paid") return msg
            const upiLink = `upi://pay?pa=${upi_handle}&pn=RAY+D&am=${o.total}&cu=INR&tn=Invoice+${o.id}`
            let tmpFile
            try {
                tmpFile = await buildFramedQr(upiLink, brand_label || website)
                await fetch(AGENT_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-secret": AGENT_SECRET },
                    body: JSON.stringify({ phone: to, message: msg, mediaPath: tmpFile })
                })
            } finally {
                if (tmpFile) fs.unlink(tmpFile, () => {})
            }
            return null
        }))
        const fallbacks = results.filter(r => r.status === "fulfilled" && r.value).map(r => r.value)
        return fallbacks.length ? fallbacks.join("\n\n") : null
    }

    if (focus === "payment") return orders.map(o => o.customer_message || paymentFocus(o)).join("\n\n")

    const header = orders.length === 1 ? "Here's your active order:" : `Here are your ${orders.length} active orders:`
    return header + "\n\n" + orders.map((o, i) =>
        orders.length > 1 ? `── Order ${i + 1} ──\n${formatOrder(o)}` : formatOrder(o)
    ).join("\n\n")
}

module.exports = { execute }
