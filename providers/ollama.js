"use strict"

const fetch = require("node-fetch")

async function complete(prompt, config) {
    const res = await fetch(config.url || "http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.model, prompt, stream: false })
    })
    const data = await res.json()
    return (data.response || "").trim()
}

module.exports = { complete }
