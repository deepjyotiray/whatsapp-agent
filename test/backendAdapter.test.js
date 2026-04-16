"use strict"

const http = require("http")
const BackendAdapter = require("../providers/adapters/backend")

let passed = 0
let failed = 0
let total = 0

function assert(label, checks) {
    total++
    const errors = checks.filter(([, ok]) => !ok).map(([desc]) => desc)
    if (errors.length) {
        console.log(`  FAIL ${label}`)
        for (const error of errors) console.log(`    -> ${error}`)
        failed++
        return
    }
    console.log(`  PASS ${label}`)
    passed++
}

async function withServer(handler, fn) {
    const server = http.createServer(handler)
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address()
    try {
        await fn(port)
    } finally {
        await new Promise(resolve => server.close(resolve))
    }
}

async function main() {
    console.log("\nBackend Adapter Tests\n")

    const adminAgentPath = require.resolve("../gateway/adminAgent")
    const originalAdminAgent = require.cache[adminAgentPath]
    try {
        require.cache[adminAgentPath] = {
            id: adminAgentPath,
            filename: adminAgentPath,
            loaded: true,
            exports: {
                dispatchAgentTask: async (_prompt, options) => JSON.stringify({
                    backend: options.backend,
                    roles: (options.messages || []).map(m => m.role).join(","),
                    first: options.messages?.[0]?.content || "",
                }),
            },
        }

        const localAdapter = new BackendAdapter({
            backend: "openclaw",
            backend_config: {
                custom_system_prompt: "local openclaw prompt",
            },
        })
        const localRaw = await localAdapter.complete([
            { role: "user", content: "hello" },
        ])
        const localParsed = JSON.parse(localRaw)
        assert("local backends receive shared custom prompt as system context", [
            ["backend forwarded", localParsed.backend === "openclaw"],
            ["system message added", localParsed.roles === "system,user"],
            ["custom prompt first", localParsed.first === "local openclaw prompt"],
        ])
    } finally {
        if (originalAdminAgent) require.cache[adminAgentPath] = originalAdminAgent
        else delete require.cache[adminAgentPath]
    }

    await withServer((req, res) => {
        if (req.method === "POST" && req.url === "/v1/chat/completions") {
            let raw = ""
            req.on("data", chunk => { raw += chunk })
            req.on("end", () => {
                const body = JSON.parse(raw || "{}")
                if (body.stream) {
                    res.writeHead(200, { "Content-Type": "text/event-stream" })
                    res.write('data: {"choices":[{"delta":{"content":"streamed "}}]}\n\n')
                    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')
                    res.end('data: [DONE]\n\n')
                    return
                }
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({
                    choices: [
                        {
                            message: {
                                content: JSON.stringify({
                                    auth: req.headers.authorization || "",
                                    model: body.model,
                                    openrouter: body.openrouter_api_key || "",
                                    roles: (body.messages || []).map(m => m.role).join(","),
                                }),
                            },
                        },
                    ],
                }))
            })
            return
        }

        if (req.method === "POST" && req.url === "/v1/ultraplinian/completions") {
            let raw = ""
            req.on("data", chunk => { raw += chunk })
            req.on("end", () => {
                const body = JSON.parse(raw || "{}")
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({
                    response: JSON.stringify({
                        auth: req.headers.authorization || "",
                        tier: body.tier,
                        openrouter: body.openrouter_api_key || "",
                        roles: (body.messages || []).map(m => m.role).join(","),
                    }),
                }))
            })
            return
        }

        if (req.method === "POST" && req.url === "/v1/consortium/completions") {
            let raw = ""
            req.on("data", chunk => { raw += chunk })
            req.on("end", () => {
                const body = JSON.parse(raw || "{}")
                res.writeHead(200, { "Content-Type": "application/json" })
                res.end(JSON.stringify({
                    response: JSON.stringify({
                        endpoint: req.url,
                        tier: body.tier,
                        liquid: body.liquid,
                        delta: body.liquid_min_delta,
                        orchestrator: body.orchestrator_model || "",
                        customPrompt: body.custom_system_prompt || "",
                        triggers: body.parseltongue_custom_triggers || [],
                    }),
                }))
            })
            return
        }

        if (req.method === "GET" && req.url === "/v1/models") {
            res.writeHead(200, { "Content-Type": "application/json" })
            res.end(JSON.stringify({
                data: [
                    { id: "ultraplinian/fast" },
                    { id: "consortium/fast" },
                ],
            }))
            return
        }

        res.writeHead(404)
        res.end()
    }, async (port) => {
        const adapter = new BackendAdapter({
            backend: "godmod3",
            endpoint: `http://127.0.0.1:${port}`,
            api_key: "godmode-secret",
            model: "ultraplinian/fast",
            backend_config: {
                openrouter_api_key: "sk-or-v1-test",
            },
        })

        const raw = await adapter.complete([
            { role: "system", content: "ignored?" },
            { role: "user", content: [{ text: "Hello" }, " world"] },
        ])
        const parsed = JSON.parse(raw)
        assert("godmod3 backend posts OpenAI-compatible chat payload", [
            ["auth header forwarded", parsed.auth === "Bearer godmode-secret"],
            ["tier forwarded", parsed.tier === "fast"],
            ["openrouter key forwarded", parsed.openrouter === "sk-or-v1-test"],
            ["messages preserved without system role duplication", parsed.roles === "user"],
        ])

        const consortiumAdapter = new BackendAdapter({
            backend: "godmod3",
            endpoint: `http://127.0.0.1:${port}`,
            model: "consortium/fast",
            backend_config: {
                godmode_enabled: true,
                custom_system_prompt: "custom layer",
                parseltongue_custom_triggers: ["alpha", "beta"],
                liquid: false,
                liquid_min_delta: 13,
                orchestrator_model: "anthropic/claude-sonnet-4",
            },
        })
        const consortiumRaw = await consortiumAdapter.complete([
            { role: "system", content: "business context" },
            { role: "user", content: "hello there" },
        ])
        const consortiumParsed = JSON.parse(consortiumRaw)
        assert("godmod3 virtual consortium models hit dedicated endpoint with advanced config", [
            ["dedicated endpoint used", consortiumParsed.endpoint === "/v1/consortium/completions"],
            ["tier extracted", consortiumParsed.tier === "fast"],
            ["liquid forwarded", consortiumParsed.liquid === false],
            ["delta forwarded", consortiumParsed.delta === 13],
            ["orchestrator forwarded", consortiumParsed.orchestrator === "anthropic/claude-sonnet-4"],
            ["system context preserved in custom prompt", /business context/.test(consortiumParsed.customPrompt)],
            ["custom prompt preserved", /custom layer/.test(consortiumParsed.customPrompt)],
            ["custom triggers forwarded", Array.isArray(consortiumParsed.triggers) && consortiumParsed.triggers.length === 2],
        ])

        const models = await adapter.listModels()
        assert("godmod3 backend can discover models", [
            ["models returned", Array.isArray(models) && models.length === 2],
            ["ultraplinian present", models.includes("ultraplinian/fast")],
        ])

        const streamingAdapter = new BackendAdapter({
            backend: "godmod3",
            endpoint: `http://127.0.0.1:${port}`,
            model: "nousresearch/hermes-3-llama-3.1-70b",
            backend_config: {
                stream: true,
            },
        })
        const streamed = await streamingAdapter.complete([
            { role: "user", content: "hello" },
        ])
        assert("godmod3 backend can consume streamed SSE responses", [
            ["stream content combined", streamed === "streamed hello"],
        ])
    })

    console.log(`\nPassed: ${passed}/${total}`)
    if (failed) process.exit(1)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
