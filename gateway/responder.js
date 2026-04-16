"use strict"

const { complete } = require("../providers/llm")

const DEFAULT_SYSTEM_PROMPT = `You are a helpful business assistant.
You will be given a customer's question and data retrieved from the business database.
Answer using ONLY the provided data. Be well formatted for WhatsApp.
Do NOT make up information. If nothing matches, say so clearly.
Include ALL matching items from the retrieved data — never truncate or summarise the list.
If the customer asks whether a category or type is available, answer yes/no and then list all matching items with their exact names and prices.
Never collapse multiple relevant matches into a single example item.`

const MAX_RAG_CHARS = 12000

async function generateResponse(userQuery, ragData, systemPrompt, options = {}) {
    // fast path: RAG already said nothing matched — no LLM needed
    if (!ragData || ragData.startsWith("Sorry, nothing matched") || ragData.includes("not available")) {
        return ragData || "Sorry, nothing matched your query."
    }

    // truncate if RAG returned too much
    const trimmed = ragData.length > MAX_RAG_CHARS
        ? ragData.slice(0, MAX_RAG_CHARS) + "\n\n(data truncated)"
        : ragData
    const history = Array.isArray(options.history) ? options.history.slice(-6) : []
    const historyBlock = history.length
        ? `\nRecent conversation:\n${history.map(turn => `${turn.role}: ${turn.text}`).join("\n")}\n`
        : ""

    const prompt = `${systemPrompt || DEFAULT_SYSTEM_PROMPT}

Customer question: ${userQuery}
${historyBlock}

Retrieved data:
${trimmed}

Answer:`

    try {
        const text = await complete(prompt, { flow: "customer" })
        return text || ragData
    } catch {
        return ragData
    }
}

module.exports = { generateResponse }
