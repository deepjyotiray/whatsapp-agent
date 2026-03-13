"use strict"

const pino = require("pino")
const settings = require("../config/settings.json")

const logger = pino({
    level: settings.log.level,
    transport: {
        targets: [
            { target: "pino/file", options: { destination: "./logs/agent.log" }, level: settings.log.level },
            { target: "pino-pretty", options: { colorize: true }, level: settings.log.level }
        ]
    }
})

module.exports = logger
