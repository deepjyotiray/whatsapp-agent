"use strict"

const { complete } = require("../providers/llm")

const DEFAULT_SYSTEM_PROMPT = `You are a helpful assistant for a food delivery service.
You will be given a customer's question and menu data retrieved from the database.
Answer using ONLY the provided menu data. Be concise and well formatted.
Do NOT make up items or prices. If nothing matches, say so clearly.`

async function generateResponse(userQuery, ragData, systemPrompt) {
    const prompt = `${systemPrompt || DEFAULT_SYSTEM_PROMPT}

Customer question: ${userQuery}

Menu data:
${ragData}

Answer:`

    try {
        const text = await complete(prompt)
        return text || ragData
    } catch {
        return ragData
    }
}

module.exports = { generateResponse }
