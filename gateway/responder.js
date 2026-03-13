"use strict"

const fetch = require("node-fetch")
const settings = require("../config/settings.json")

const SYSTEM_INSTRUCTION = `You are a helpful assistant for Ray's Home Kitchen, a food delivery service.

You will be given:
1. A customer's question
2. A list of menu items with prices retrieved from the database

Your job is to answer the customer's question using ONLY the provided menu data.

Rules:
- Only include items that are directly relevant to what was asked
- If asked for "main course", exclude sides, breads, drinks, desserts, chutneys
- If asked for "veg", only include veg items
- If asked for "non-veg", only include non-veg items  
- If a price filter was mentioned, strictly respect it
- Keep the response concise and well formatted
- Do NOT make up items or prices
- Do NOT answer anything unrelated to the menu data provided
- If nothing matches, say so clearly`

/**
 * Uses the LLM to generate a focused response from RAG data.
 * LLM only formats/filters — it never calls tools or accesses data itself.
 *
 * @param {string} userQuery - original user message
 * @param {string} ragData   - raw text retrieved from RAG/DB
 * @returns {Promise<string>}
 */
async function generateResponse(userQuery, ragData) {
    const prompt = `${SYSTEM_INSTRUCTION}

Customer question: ${userQuery}

Menu data:
${ragData}

Answer:`

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
        const data = await response.json()
        const text = (data.response || "").trim()
        return text || ragData  // fallback to raw data if LLM returns empty
    } catch {
        return ragData  // fallback to raw RAG data on any error
    }
}

module.exports = { generateResponse }
