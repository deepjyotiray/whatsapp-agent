"use strict"

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers, downloadMediaMessage } = require("@whiskeysockets/baileys")
const P = require("pino")
const fs = require("fs")
const path = require("path")
const os = require("os")
const settings = require("../config/settings.json")
const qrcode = require("qrcode-terminal")
const { pipeline } = require("../gateway/pipeline")
const { startApi, setSock, setConnected } = require("./api")
const logger = require("../gateway/logger")

// Resolve a Baileys LID JID (226997762576508@lid) to a real phone JID
// Baileys writes reverse mapping files to auth/ when contacts are seen
function resolveJid(jid) {
    if (!jid || !jid.endsWith("@lid")) return jid
    const lid = jid.replace(/@.*$/, "")
    const mapFile = path.resolve("auth", `lid-mapping-${lid}_reverse.json`)
    try {
        const phone = JSON.parse(fs.readFileSync(mapFile, "utf8"))
        return phone + "@s.whatsapp.net"
    } catch {
        return jid
    }
}

async function start() {
    const { state, saveCreds } = await useMultiFileAuthState("auth")
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: "silent" }),
        browser: Browsers.macOS("Desktop"),
        markOnlineOnConnect: true
    })

    setSock(sock)

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", ({ connection, qr, lastDisconnect }) => {
        if (qr) {
            console.log("\nScan this QR with WhatsApp\n")
            qrcode.generate(qr, { small: true })
        }
        if (connection === "open") {
            setConnected(true)
            logger.info("WhatsApp connected")
        }
        if (connection === "close") {
            setConnected(false)
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
            logger.info({ shouldReconnect }, "Connection closed")
            if (shouldReconnect) start()
        }
    })

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0]
        if (!msg.message || msg.key.fromMe) return

        const rawJid = msg.key.remoteJid
        const phone = resolveJid(rawJid)

        // Payment screenshot — image sent by customer
        if (msg.message.imageMessage) {
            logger.info({ phone }, "inbound image — forwarding to payment-watcher")
            try {
                const stream = await downloadMediaMessage(msg, "buffer", {})
                const tmpPath = path.join(os.tmpdir(), `payment-${Date.now()}.jpg`)
                fs.writeFileSync(tmpPath, stream)
                await fetch("http://127.0.0.1:3002/payment", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "x-secret": settings.api.secret },
                    body: JSON.stringify({ phone: phone.replace(/@.*$/, ""), imagePath: tmpPath })
                })
            } catch (err) {
                logger.error({ err }, "payment forward failed")
            }
            return
        }

        const text =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            null

        if (!text) return

        logger.info({ phone, rawJid, text }, "inbound message")

        const response = await pipeline(text, phone)

        if (response) await sock.sendMessage(rawJid, { text: response })
    })
}

module.exports = { start }
