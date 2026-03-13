"use strict"

const llm = require("../providers/llm")

/**
 * @param {string} message
 * @param {string[]} allowedIntents - from manifest
 * @param {object} intentHints      - from manifest: { intent_name: "description" }
 * @returns {Promise<{ intent: string, parameters: object }>}
 */
async function parseIntent(message, allowedIntents = [], intentHints = {}) {
    const intentList = [...allowedIntents, "unknown"].join(", ")

    const hints = Object.entries(intentHints)
        .map(([k, v]) => `Use "${k}" for: ${v}`)
        .join("\n")

    const prompt = `You are a command classifier. Your only job is to convert a user message into a JSON intent object.

You must ONLY output valid JSON. No explanation. No extra text.

Allowed intents: ${intentList}

${hints}
Use "unknown" for everything else.

For any intent, extract a "query" parameter with key search terms from the message if relevant.

Output format:
{
  "intent": "<intent>",
  "parameters": { "query": "<extracted search terms or empty string>" }
}

User message:
${message}`

    const raw = await llm.complete(prompt)
    const match = raw.match(/\{[\s\S]*\}/)
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
