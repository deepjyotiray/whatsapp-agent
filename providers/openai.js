"use strict"

const fetch = require("node-fetch")

async function complete(prompt, config) {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${config.api_key}`
        },
        body: JSON.stringify({
            model: config.model || "gpt-4o-mini",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3
        })
    })
    const data = await res.json()
    return (data.choices?.[0]?.message?.content || "").trim()
}

module.exports = { complete }
