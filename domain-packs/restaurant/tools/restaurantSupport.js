"use strict"

const Database = require("better-sqlite3")
const fetch    = require("node-fetch")
const settings = require("../../../config/settings.json")
const cart     = require("../../../tools/cartStore")
const logger   = require("../../../gateway/logger")

const SEND_URL    = `http://127.0.0.1:${settings.api.port}/send`
const SEND_SECRET = settings.api.secret

const MENU = `How can we help you today?\n\n1. Wrong or missing item\n2. Late delivery\n3. Payment issue\n4. Request a refund\n5. Talk to a human\n\nReply with a number, or *0* to go back to main menu.`

const PROMPTS = {
    1: `Please describe what was wrong or missing with your order.\n\nReply with your message, or *0* to go back.`,
    2: `Please describe the delivery issue — how long have you been waiting and what was your expected delivery time?\n\nReply with your message, or *0* to go back.`,
    3: `Please share your UPI transaction ID or describe the payment issue.\n\nReply with your message, or *0* to go back.`,
    4: `Please describe why you'd like a refund and share your order ID if you have it.\n\nReply with your message, or *0* to go back.`,
    5: `Please describe your issue and we'll connect you with our team right away.\n\nReply with your message, or *0* to go back.`,
}

const LABELS = { 1: "Wrong/missing item", 2: "Late delivery", 3: "Payment issue", 4: "Refund request", 5: "Talk to human" }

const SUPPORT_INFO_HINTS = [
    /\b(email|e-mail|mail)\b/i,
    /\bphone\b/i,
    /\bcontact\b/i,
    /\bsupport\b/i,
    /\bhours?\b/i,
    /\bopen\b/i,
    /\baddress\b/i,
    /\blocation\b/i,
    /\brefund\b/i,
    /\bpolicy\b/i,
    /\bpayment methods?\b/i,
]

const COMPLAINT_HINTS = [
    /\bwrong\b/i,
    /\bmissing\b/i,
    /\blate\b/i,
    /\bdelay(ed)?\b/i,
    /\brefund\b/i,
    /\bissue\b/i,
    /\bproblem\b/i,
    /\bcomplaint\b/i,
    /\bhuman\b/i,
]

function normalisePhone(p) { return String(p).replace(/@.*$/, "").replace(/\D/g, "") }

function getCustomerContext(dbPath, phone) {
    const last10 = normalisePhone(phone).slice(-10)
    const db = new Database(dbPath, { readonly: true })
    db.pragma("busy_timeout = 5000")
    try {
        const user   = db.prepare("SELECT name FROM users WHERE mobile LIKE ?").get(`%${last10}`)
        const orders = db.prepare(`
            SELECT id, order_for, total, delivery_status, payment_status, items
            FROM orders WHERE phone LIKE ?
            ORDER BY created_at DESC LIMIT 3
        `).all(`%${last10}`)
        return { user, orders }
    } finally { db.close() }
}

async function escalate(phone, issueLabel, issueText, customerContext, adminPhone) {
    const last10 = normalisePhone(phone).slice(-10)
    const name   = customerContext.user?.name || "Unknown customer"
    const orders = customerContext.orders.map(o =>
        `• ${o.id} | ${o.order_for} | ₹${o.total} | ${o.delivery_status} | ${o.payment_status}`
    ).join("\n") || "No recent orders"
    const to  = adminPhone.startsWith("+") ? adminPhone : `+${adminPhone}`
    const msg = `🚨 *Support Request*\n\n👤 ${name} (+${last10})\n📋 Issue: ${issueLabel}\n💬 "${issueText}"\n\n📦 Recent Orders:\n${orders}`
    try {
        await fetch(SEND_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-secret": SEND_SECRET },
            body: JSON.stringify({ phone: to, message: msg })
        })
        logger.info({ phone }, "support: escalated to admin")
    } catch (err) {
        logger.error({ err }, "support: escalation failed")
    }
}

function isSupportInfoQuestion(text) {
    return SUPPORT_INFO_HINTS.some(re => re.test(text)) && !/^\d+$/.test(text.trim())
}

function isComplaintLike(text) {
    return COMPLAINT_HINTS.some(re => re.test(text))
}

function deterministicSupportInfo(profile = {}) {
    const lines = []
    if (profile.contactEmail) lines.push(`Support email: ${profile.contactEmail}`)
    if (profile.contactPhone) lines.push(`Support phone: ${profile.contactPhone}`)
    if (profile.website) lines.push(`Website: ${profile.website}`)
    if (profile.businessHours) lines.push(`Business hours: ${profile.businessHours}`)
    return lines.join("\n") || "Please contact our support team and we'll help you shortly."
}

async function answerSupportInfo(text, context) {
    const profile = context.profile || {}
    const prompt = `[INST] You are a customer support assistant for ${profile.businessName || "the business"}.
Answer using ONLY the grounded business profile details below.
If the requested detail is missing, say you do not have that detail available and invite the customer to contact the team directly.
Keep the answer short and WhatsApp-friendly.

Business profile:
${context.profileFacts || "No profile data available."}

Customer question:
${text}
[/INST]`

    try {
        if (typeof context.prepareLLMRequest === "function") {
            const textReply = await context.prepareLLMRequest(prompt)
            if (textReply) return textReply
        }
    } catch {}
    return deterministicSupportInfo(profile)
}

async function execute(_params, context, toolConfig) {
    const { phone, rawMessage: msg } = context
    const { db_path, escalation_phone } = toolConfig
    const adminPhone = escalation_phone || settings.admin?.number || ""
    const text = (msg || "").trim()
    const n    = parseInt(text, 10)
    const key  = `support:${phone}`

    let c = cart.get(key)

    if (!c && isSupportInfoQuestion(text) && !isComplaintLike(text)) {
        return await answerSupportInfo(text, context)
    }

    if (!c) {
        cart.set(key, { state: "menu" })
        return MENU
    }

    const { state } = c

    if (state === "menu") {
        if (n >= 1 && n <= 5) {
            cart.update(key, { state: "collecting", issueType: n })
            return PROMPTS[n]
        }
        if (text === "0") {
            cart.clear(key)
            return null
        }
        return `Please reply with a number between 1 and 5.\n\n${MENU}`
    }

    if (state === "collecting") {
        if (text === "0") {
            cart.update(key, { state: "menu" })
            return MENU
        }
        if (text.length < 3) return "Please describe your issue so we can help you."

        const ctx = getCustomerContext(db_path, phone)
        await escalate(phone, LABELS[c.issueType], text, ctx, adminPhone)
        cart.clear(key)
        return `Thank you! 🙏 We've received your message and our team will get back to you shortly.\n\nWe typically respond within 30 minutes during business hours.`
    }

    cart.clear(key)
    return MENU
}

module.exports = { execute }
