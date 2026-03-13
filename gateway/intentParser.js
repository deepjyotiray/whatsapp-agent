"use strict"

const fetch = require("node-fetch")
const settings = require("../config/settings.json")

const SYSTEM_INSTRUCTION = `You are a command classifier. Your only job is to convert a user message into a JSON intent object.

You must ONLY output valid JSON. No explanation. No extra text.

Allowed intents: show_menu, help, greet, order_status, unknown

Use "greet" for: hi, hello, hey, good morning, good evening, namaste, or any greeting.
Use "show_menu" for: menu, what's available, what do you have, today's food, show items, price queries, veg/non-veg questions, specific food item questions.
Use "order_status" for: my order, order status, where is my order, track order, delivery status, when will it be delivered, is my payment done, payment status, unpaid, pending payment, has my order arrived, send invoice, resend invoice, payment QR, UPI link, QR code, bill, receipt, how much do I owe, total amount, payment link, send me the QR.
Use "cancel_order" for: cancel, cancel my order, cancel the order, cancel it, I want to cancel, stop my order.
Use "help" for: help, what can you do, how does this work.
Use "unknown" for everything else.

For show_menu, extract a "query" parameter with the key search terms from the message.

Output format:
{
  "intent": "<intent>",
  "parameters": { "query": "<extracted search terms or empty string>" }
}`

/**
 * @param {string} message - sanitized user message
 * @returns {Promise<{ intent: string, parameters: object }>}
 */
async function parseIntent(message) {
    const prompt = `${SYSTEM_INSTRUCTION}\n\nUser message:\n${message}`

    let data
    try {
        const response = await fetch(settings.ollama.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: settings.ollama.model,
                prompt,
                stream: false
            })
        })
        data = await response.json()
    } catch {
        return { intent: "unknown", parameters: {} }
    }

    const match = (data.response || "").match(/\{[\s\S]*\}/)
    if (!match) return { intent: "unknown", parameters: {} }

    try {
        const parsed = JSON.parse(match[0])
        if (typeof parsed.intent !== "string") return { intent: "unknown", parameters: {} }
        return { intent: parsed.intent, parameters: parsed.parameters || {} }
    } catch {
        return { intent: "unknown", parameters: {} }
    }
}

module.exports = { parseIntent }
