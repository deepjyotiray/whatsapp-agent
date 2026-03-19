"use strict"

const { complete } = require("../providers/llm")

function buildIntentGuide(allowedIntents, intentHints) {
    return allowedIntents.map(intent => {
        const hint = intentHints[intent] || "No extra hint provided."
        return `- "${intent}": ${hint}`
    }).join("\n")
}

function extractJson(text) {
    if (!text) return null
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    try { return JSON.parse(match[0]) } catch { return null }
}

async function parseIntent(message, options = {}) {
    const allowedIntents = Array.isArray(options.allowedIntents) && options.allowedIntents.length
        ? options.allowedIntents
        : ["greet", "show_menu", "order_status", "place_order", "support", "general_chat", "unknown"]
    const defaultIntent = options.defaultIntent || (allowedIntents.includes("general_chat") ? "general_chat" : allowedIntents[0])
    const prompt = `You are a WhatsApp business intent router for ${options.businessProfile || "a local business"}.
Return JSON only. No markdown. No explanation.

Allowed intents:
${buildIntentGuide(allowedIntents, options.intentHints || {})}

Routing rules:
- Prefer the most specific business intent when the message is about menu, dishes, orders, payment, support, or buying.
- Use "general_chat" for general conversation, recommendations, weather-style questions, greetings, or small talk that should still be answered in a business-aware tone.
- Never invent new intents outside the allowed list.
- Reason over the full user request before choosing an intent or filters.
- Preserve explicit constraints such as price caps, dietary preferences, quantity, section/category, nutrition limits, and comparisons.

Also extract an optional filter object:
{
  "section": null,
  "veg": null,
  "query": null,
  "max_price": null,
  "max_calories": null,
  "min_protein": null,
  "max_fat": null
}

Extraction rules:
- For "under 200", "below 200", "less than 200", set "max_price": 200.
- For "veg" or "vegetarian", set "veg": true. For "non-veg", "chicken", "mutton", "fish", or "egg" requests, set "veg": false only when the request clearly excludes veg.
- Put the searchable item/category terms in "query" without price words if possible.
- If the message is not a menu query, keep filter values null unless a field is clearly useful.
- Never drop a clear numerical constraint from the user's message.

Examples:
- "chicken dish under 200" -> {"intent":"show_menu","filter":{"section":null,"veg":false,"query":"chicken dish","max_price":200,"max_calories":null,"min_protein":null,"max_fat":null}}
- "veg starters below 150" -> {"intent":"show_menu","filter":{"section":"Veg Starters","veg":true,"query":"veg starters","max_price":150,"max_calories":null,"min_protein":null,"max_fat":null}}
- "what is your support email" -> {"intent":"general_chat","filter":{"section":null,"veg":null,"query":null,"max_price":null,"max_calories":null,"min_protein":null,"max_fat":null}}

If unsure, choose "${defaultIntent}".

Message:
${message}

Return exactly:
{"intent":"${defaultIntent}","filter":{"section":null,"veg":null,"query":null,"max_price":null,"max_calories":null,"min_protein":null,"max_fat":null}}`

    try {
        const text = await complete(prompt)
        const parsed = extractJson(text)
        if (!parsed || typeof parsed.intent !== "string") return { intent: defaultIntent, filter: {} }
        if (!allowedIntents.includes(parsed.intent)) return { intent: defaultIntent, filter: {} }
        return { intent: parsed.intent, filter: parsed.filter || {} }
    } catch {
        return { intent: defaultIntent, filter: {} }
    }
}

module.exports = { parseIntent }
