"use strict"

const { start } = require("./transport/whatsapp")
const { startApi } = require("./transport/api")

startApi()
start().catch(err => {
    console.error("Fatal error:", err)
    process.exit(1)
})
