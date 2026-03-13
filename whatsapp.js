const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys")
const P = require("pino")
const qrcode = require("qrcode-terminal")
const fetch = require("node-fetch")

const fs = require("fs")
const yaml = require("js-yaml")

const policy = yaml.load(fs.readFileSync("./policy.yml", "utf8"))

//RAG
const { retrieveContext } = require("./rag")

function policyCheck(intent){

    console.log("Checking intent:", intent.intent)
    console.log("Allowed intents:", policy.allowed_intents)

    if(!intent || !intent.intent){
        return false
    }

    return policy.allowed_intents.includes(intent.intent)
}


async function parseIntent(message){

    const prompt = `
You convert user messages into structured JSON.

Allowed intents:
- show_menu
- help
- login
- order_status

Return JSON only.

Format:

{
 "intent": "",
 "parameters": {}
}

User message:
${message}
`

    const response = await fetch("http://localhost:11434/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "llama3",
            prompt: prompt,
            stream: false
        })
    })

    const data = await response.json()

    const text = data.response

    const match = text.match(/\{[\s\S]*\}/)

    if(match){
        return JSON.parse(match[0])
    }

    return { intent: "unknown", parameters: {} }
}

async function startBot() {

    const { state, saveCreds } = await useMultiFileAuthState("auth")

    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: "silent" }),
        browser: ["Chrome", "MacOS", "121.0.0"]
    })

    sock.ev.on("creds.update", saveCreds)

    sock.ev.on("connection.update", (update) => {

        const { connection, qr, lastDisconnect } = update

        if (qr) {
            console.log("\nScan this QR with WhatsApp\n")
            qrcode.generate(qr, { small: true })
        }

        if (connection === "open") {
            console.log("✅ WhatsApp connected")
        }

        if (connection === "close") {

            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut

            console.log("Connection closed. Reconnecting:", shouldReconnect)

            if (shouldReconnect) {
                startBot()
            }

        }

    })

    sock.ev.on("messages.upsert", async ({ messages }) => {

    const msg = messages[0]

    if (!msg.message) return
    if (msg.key.fromMe) return

    const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        null

    if (!text) return

    console.log("User:", text)

    const response = await gateway(text)

    await sock.sendMessage(msg.key.remoteJid, {
        text: response
    })

})

}
async function gateway(message){

    const intent = await parseIntent(message)

    console.log("Parsed intent:", intent)

    if(!policyCheck(intent)){
        return "Sorry, I cannot perform that request."
    }

    return await executeIntent(intent, message)
}

async function executeIntent(intent, message){

    if(intent.intent === "show_menu"){

        const context = await retrieveContext(message)

        return context
    }

    if(intent.intent === "help"){
        return "You can ask for the menu or check your order status."
    }

    if(intent.intent === "login"){
        return "Please login on the website to continue."
    }

    return "Intent recognized but not implemented."
}

startBot()
