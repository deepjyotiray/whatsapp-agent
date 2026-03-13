"use strict"

const fetch = require("node-fetch")

async function complete(prompt, config) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-api-key": config.api_key,
            "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
            model: config.model || "claude-3-haiku-20240307",
            max_tokens: 1024,
            messages: [{ role: "user", content: prompt }]
        })
    })
    const data = await res.json()
    return (data.content?.[0]?.text || "").trim()
}

module.exports = { complete }
