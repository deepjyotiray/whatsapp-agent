"use strict"

const http = require("http")
const settings = require("../config/settings.json")
const logger = require("../gateway/logger")

let _sock = null
let _connected = false

function setSock(sock) {
    _sock = sock
}

function setConnected(val) {
    _connected = val
}

/**
 * POST /send
 * Body: { phone: "+91XXXXXXXXXX", message: "..." }
 * Header: x-secret: <settings.api.secret>
 */
const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/send") {
        res.writeHead(404).end()
        return
    }

    if (req.headers["x-secret"] !== settings.api.secret) {
        res.writeHead(401).end(JSON.stringify({ error: "unauthorized" }))
        return
    }

    let body = ""
    req.on("data", chunk => { body += chunk })
    req.on("end", async () => {
        try {
            const { phone, message, mediaPath } = JSON.parse(body)

            if (!phone || !message) {
                res.writeHead(400).end(JSON.stringify({ error: "phone and message required" }))
                return
            }

            if (!_sock) {
                res.writeHead(503).end(JSON.stringify({ error: "whatsapp not connected" }))
                return
            }

            if (!_connected) {
                res.writeHead(503).end(JSON.stringify({ error: "whatsapp session not ready" }))
                return
            }

            const jid = phone.replace(/^\+/, "") + "@s.whatsapp.net"

            if (mediaPath) {
                const fs = require("fs")
                const image = fs.readFileSync(mediaPath)
                await _sock.sendMessage(jid, { image, caption: message })
            } else {
                await _sock.sendMessage(jid, { text: message })
            }
            logger.info({ phone }, "api: message sent")
            res.writeHead(200).end(JSON.stringify({ ok: true }))
        } catch (err) {
            logger.error({ err }, "api: send failed")
            res.writeHead(500).end(JSON.stringify({ error: err.message }))
        }
    })
})

function startApi() {
    server.listen(settings.api.port, "127.0.0.1", () => {
        logger.info({ port: settings.api.port }, "whatsapp-agent API listening")
    })
}

module.exports = { startApi, setSock, setConnected }
