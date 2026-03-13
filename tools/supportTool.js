"use strict"

const fs       = require("fs")
const yaml     = require("js-yaml")
const Database = require("better-sqlite3")
const settings = require("../config/settings.json")
const { complete } = require("../providers/llm")
const { getHistory, addTurn } = require("../runtime/sessionMemory")
const logger   = require("../gateway/logger")

const AGENT_URL    = `http://127.0.0.1:${settings.api.port}/send`
const AGENT_SECRET = settings.api.secret

function loadFaq(faqPath) {
    return yaml.load(fs.readFileSync(faqPath, "utf8"))
}

function matchFaq(faqs, message) {
    const m = message.toLowerCase()
    let best = null, bestScore = 0
    for (const faq of faqs) {
        const score = faq.keywords.reduce((n, kw) => n + (m.includes(kw) ? 1 : 0), 0)
        if (score > bestScore) { bestScore = score; best = faq }
    }
    return bestScore > 0 ? best : null
}

function isEscalationRequest(message, triggers) {
    const m = message.toLowerCase()
    return triggers.some(t => m.includes(t.toLowerCase()))
}

function getCustomerContext(dbPath, phone) {
    const last10 = String(phone).replace(/@.*$/, "").replace(/\D/g, "").slice(-10)
    const db = new Database(dbPath, { readonly: true })
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

async function askLlm(message, history, faqContext, customerContext, businessName) {
    const historyText  = history.length
        ? history.map(h => `${h.role === "customer" ? "Customer" : "Agent"}: ${h.text}`).join("\n")
        : "No prior conversation."
    const customerText = customerContext.user
        ? `Customer name: ${customerContext.user.name}\nRecent orders:\n${customerContext.orders.map(o =>
            `- ${o.id} | ${o.order_for} | ₹${o.total} | ${o.delivery_status} | ${o.payment_status}`
          ).join("\n") || "None"}`
        : "Customer not registered."

    const prompt = `You are a friendly and empathetic customer support agent for ${businessName}, a home-cooked food delivery service.
Resolve the customer's issue using the FAQ knowledge and their order context below.
Rules:
- Be warm, empathetic, and concise
- Use the customer's name if available
- Reference their actual order details if relevant
- If you cannot resolve the issue, tell them to say "talk to human"
- Never make up policies or promises
- Do NOT answer anything unrelated to food, orders, or the business

FAQ Knowledge:
${faqContext}

Customer Context:
${customerText}

Conversation so far:
${historyText}

Customer: ${message}
Agent:`

    try {
        return await complete(prompt) || null
    } catch {
        return null
    }
}

async function escalateToAdmin(phone, message, history, customerContext, adminPhone) {
    const last10  = String(phone).replace(/@.*$/, "").replace(/\D/g, "").slice(-10)
    const name    = customerContext.user?.name || "Unknown customer"
    const orders  = customerContext.orders.map(o =>
        `• ${o.id} | ${o.order_for} | ₹${o.total} | ${o.delivery_status} | ${o.payment_status}`
    ).join("\n") || "No recent orders"
    const convo   = history.length
        ? history.map(h => `${h.role === "customer" ? "👤" : "🤖"} ${h.text}`).join("\n")
        : message
    const adminMsg = `🚨 *Support Escalation*\n\n👤 Customer: ${name} (+${last10})\n\n📦 Recent Orders:\n${orders}\n\n💬 Conversation:\n${convo}\n\n❓ Last message: "${message}"`
    const to = adminPhone.startsWith("+") ? adminPhone : `+${adminPhone}`
    try {
        await fetch(AGENT_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-secret": AGENT_SECRET },
            body: JSON.stringify({ phone: to, message: adminMsg })
        })
        logger.info({ phone }, "support: escalated to admin")
    } catch (err) {
        logger.error({ err }, "support: escalation failed")
    }
}

async function execute(params, context, toolConfig) {
    const { phone, rawMessage } = context
    const businessName  = toolConfig.business_name || "the restaurant"
    const adminPhone    = toolConfig.escalation_phone || settings.admin.number
    const faqData       = loadFaq(toolConfig.faq_path)
    const history       = getHistory(phone)
    const triggers      = faqData.escalation_triggers || []

    if (isEscalationRequest(rawMessage, triggers)) {
        const customerContext = getCustomerContext(toolConfig.db_path, phone)
        await escalateToAdmin(phone, rawMessage, history, customerContext, adminPhone)
        addTurn(phone, rawMessage, null)
        return "I've notified our team and someone will reach out to you shortly. 🙏\nWe typically respond within 30 minutes during business hours."
    }

    const customerContext = getCustomerContext(toolConfig.db_path, phone)
    const faqMatch  = matchFaq(faqData.faqs, rawMessage)
    const faqContext = faqMatch
        ? `Most relevant FAQ:\nTopic: ${faqMatch.topic}\n${faqMatch.answer}`
        : faqData.faqs.map(f => `Topic: ${f.topic}\n${f.answer}`).join("\n---\n")

    const response = await askLlm(rawMessage, history, faqContext, customerContext, businessName)

    if (!response) {
        await escalateToAdmin(phone, rawMessage, history, customerContext, adminPhone)
        addTurn(phone, rawMessage, null)
        return "I wasn't able to resolve this one. I've flagged it to our team and someone will get back to you shortly. 🙏"
    }

    addTurn(phone, rawMessage, response)
    return response
}

module.exports = { execute }
