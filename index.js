"use strict"

const path       = require("path")
const agentChain = require("./runtime/agentChain")
const { startApi } = require("./transport/api")
const { start: startHttpConsole } = require("./transports/http")

const agentFlag    = process.argv.indexOf("--agent")
const manifestPath = agentFlag !== -1 ? process.argv[agentFlag + 1] : "agents/restaurant.yml"

if (!manifestPath) {
    console.error("Usage: node index.js --agent agents/restaurant.yml")
    process.exit(1)
}

agentChain.loadAgent(path.resolve(manifestPath))

const transportFlag = process.argv.indexOf("--transport")
const transportName = transportFlag !== -1 ? process.argv[transportFlag + 1] : "whatsapp"

const TRANSPORTS = {
    whatsapp: () => {
        startApi()
        startHttpConsole()
        const { start } = require("./transports/whatsapp")
        return start()
    },
    http: () => {
        const { start } = require("./transports/http")
        return start()
    },
    cli: () => {
        const { start } = require("./transports/cli")
        return start()
    },
}

const transport = TRANSPORTS[transportName]
if (!transport) {
    console.error(`Unknown transport: ${transportName}. Available: ${Object.keys(TRANSPORTS).join(", ")}`)
    process.exit(1)
}

Promise.resolve(transport()).catch(err => {
    console.error("Fatal error:", err)
    process.exit(1)
})
