"use strict"

const path = require("path")

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

function loadCustomerFlowWithStubs({
    flowConfig = { backend: "direct" },
    routedIntent = { intent: "general_chat", filter: {} },
    cachedIntent = null,
    followUpMessage = null,
    preRoutePolicy = { allowed: true, reason: "in_domain" },
    resolvedPolicy = { allowed: true, reason: "allowed", governance: { risk: "low" } },
    plannerResult = { mode: "refuse", reason: "planner_refused" },
} = {}) {
    const root = path.resolve(__dirname, "..")
    const setStub = (relPath, exports) => {
        const fullPath = path.join(root, relPath)
        require.cache[require.resolve(fullPath)] = {
            id: fullPath,
            filename: fullPath,
            loaded: true,
            exports,
        }
    }

    const sessions = new Map()

    setStub("tools/cartStore.js", {
        get(key) { return sessions.get(key) || null },
        clear(key) { sessions.delete(key) },
    })
    setStub("gateway/customerRouter.js", {
        async routeCustomerMessage() {
            return routedIntent
        },
    })
    setStub("providers/llm.js", {
        getFlowConfig() {
            return flowConfig
        },
    })
    setStub("runtime/previewEngine.js", {
        getCachedIntent() {
            return cachedIntent
        },
    })
    setStub("runtime/followUpResolver.js", {
        resolveFollowUp({ message }) {
            return {
                resolved: !!followUpMessage,
                message: followUpMessage || message,
                reason: followUpMessage ? "selection_follow_up" : null,
                confidence: followUpMessage ? 0.9 : 0,
            }
        },
    })
    setStub("runtime/resolvedRequest.js", {
        buildResolvedRequest({ originalMessage, effectiveMessage }) {
            return {
                flow: "customer",
                originalMessage,
                effectiveMessage,
                wasRewritten: originalMessage !== effectiveMessage,
                appliedFilters: {},
                lastIntent: null,
                activeTopic: null,
            }
        },
    })
    setStub("core/workspace.js", {
        getActiveWorkspace() {
            return "ws-test"
        },
    })
    setStub("runtime/customerPolicy.js", {
        evaluateCustomerPreRoutePolicy({ stateContext }) {
            if (stateContext?.bypassPreRoutePolicy) return { allowed: true, reason: "stateful_follow_up" }
            return preRoutePolicy
        },
        evaluateCustomerResolvedPolicy() {
            return resolvedPolicy
        },
    })
    setStub("runtime/customerPlanner.js", {
        async planCustomerTurn() {
            return plannerResult
        },
    })
    setStub("setup/profileService.js", {
        loadProfile() {
            return { dbPath: "./data/orders.db" }
        },
    })
    setStub("runtime/customerProfileHydrator.js", {
        hydrateCustomerProfile() {
            return {}
        },
    })

    const customerFlowPath = path.join(root, "runtime/customerFlow.js")
    delete require.cache[require.resolve(customerFlowPath)]
    return {
        customerFlow: require(customerFlowPath),
        sessions,
    }
}

async function main() {
    console.log("\nCustomer Flow Tests\n")

    {
        const { customerFlow } = loadCustomerFlowWithStubs({
            flowConfig: { backend: "direct" },
            routedIntent: { intent: "general_chat", filter: { query: "hours" } },
        })
        let executed = null
        let backendCalls = 0
        const result = await customerFlow.executeCustomerFlow({
            message: "what are your timings",
            phone: "p1",
            manifest: { intents: { general_chat: {}, support: {} } },
            domainPack: null,
            sessionRouting: {},
            conversationState: {},
            async executeIntent(payload) {
                executed = payload
                return "tool-response"
            },
            async answerViaConfiguredMode() {
                backendCalls++
                return "backend-response"
            },
        })

        assert("direct mode uses tool path", [
            ["tool route chosen", result.route === "customer_tool"],
            ["tool executor invoked", !!executed],
            ["backend not invoked", backendCalls === 0],
            ["intent preserved", executed && executed.intent.intent === "general_chat"],
        ])
    }

    {
        const { customerFlow } = loadCustomerFlowWithStubs({
            flowConfig: { backend: "direct" },
            preRoutePolicy: { allowed: false, reason: "out_of_domain", response: "OOD" },
            plannerResult: {
                mode: "respond",
                response: "You told me to call you Boss.",
                groundedIn: "customer_profile",
                reason: "planner_grounded_profile",
            },
        })
        let executed = 0
        let backendCalls = 0
        const result = await customerFlow.executeCustomerFlow({
            message: "what is my name",
            phone: "pmemory",
            manifest: { agent: { out_of_domain_message: "OOD" }, intents: { general_chat: {} } },
            domainPack: null,
            sessionRouting: {},
            conversationState: {
                customerProfile: {
                    preferredName: "Boss",
                },
            },
            async executeIntent() {
                executed++
                return "tool-response"
            },
            async answerViaConfiguredMode() {
                backendCalls++
                return "backend-response"
            },
        })

        assert("blocked conversational turns can be answered by the grounded planner", [
            ["planner route chosen", result.route === "customer_planner"],
            ["planner answer returned", result.response === "You told me to call you Boss."],
            ["tool executor not invoked", executed === 0],
            ["backend not invoked", backendCalls === 0],
        ])
    }

    {
        const root = path.resolve(__dirname, "..")
        const setStub = (relPath, exports) => {
            const fullPath = path.join(root, relPath)
            require.cache[require.resolve(fullPath)] = {
                id: fullPath,
                filename: fullPath,
                loaded: true,
                exports,
            }
        }
        const sessions = new Map()
        let hydratedCalls = 0
        setStub("tools/cartStore.js", {
            get(key) { return sessions.get(key) || null },
            clear(key) { sessions.delete(key) },
        })
        setStub("gateway/customerRouter.js", {
            async routeCustomerMessage() {
                return { intent: "general_chat", filter: {} }
            },
        })
        setStub("providers/llm.js", {
            getFlowConfig() {
                return { backend: "direct" }
            },
        })
        setStub("runtime/previewEngine.js", { getCachedIntent() { return null } })
        setStub("runtime/followUpResolver.js", {
            resolveFollowUp({ message }) {
                return { resolved: false, message, reason: null, confidence: 0 }
            },
        })
        setStub("runtime/resolvedRequest.js", {
            buildResolvedRequest({ originalMessage, effectiveMessage }) {
                return { flow: "customer", originalMessage, effectiveMessage, wasRewritten: false, appliedFilters: {}, lastIntent: null, activeTopic: null }
            },
        })
        setStub("core/workspace.js", { getActiveWorkspace() { return "ws-test" } })
        setStub("runtime/customerPolicy.js", {
            evaluateCustomerPreRoutePolicy() { return { allowed: true, reason: "in_domain" } },
            evaluateCustomerResolvedPolicy() { return { allowed: true, reason: "allowed", governance: { risk: "low" } } },
        })
        setStub("runtime/customerPlanner.js", {
            async planCustomerTurn() {
                return { mode: "refuse", reason: "planner_refused" }
            },
        })
        setStub("setup/profileService.js", {
            loadProfile() {
                return { dbPath: "./data/orders.db" }
            },
        })
        setStub("runtime/customerProfileHydrator.js", {
            hydrateCustomerProfile() {
                hydratedCalls++
                return { name: "Riya Sharma" }
            },
        })
        const customerFlowPath = path.join(root, "runtime/customerFlow.js")
        delete require.cache[require.resolve(customerFlowPath)]
        const customerFlow = require(customerFlowPath)
        let observedState = null
        const result = await customerFlow.executeCustomerFlow({
            message: "what is my name",
            phone: "pmemory-db",
            manifest: { intents: { general_chat: {} } },
            domainPack: null,
            sessionRouting: {},
            conversationState: {},
            async executeIntent(payload) {
                observedState = payload.conversationState
                return "tool-response"
            },
            async answerViaConfiguredMode() {
                return "backend-response"
            },
        })

        assert("customer flow hydrates db-backed customer profile before execution", [
            ["tool route chosen", result.route === "customer_tool"],
            ["hydrator invoked", hydratedCalls === 1],
            ["hydrated name exposed in conversation state", observedState && observedState.customerProfile && observedState.customerProfile.name === "Riya Sharma"],
        ])
    }

    {
        const { customerFlow } = loadCustomerFlowWithStubs({
            flowConfig: { backend: "openclaw" },
            routedIntent: { intent: "show_menu", filter: { min_protein: 20 } },
        })
        let backendCalls = 0
        let executed = null
        let backendPayload = null
        const result = await customerFlow.executeCustomerFlow({
            message: "High spicy.",
            phone: "pclarify",
            manifest: { intents: { general_chat: {}, greet: {}, show_menu: {} } },
            domainPack: null,
            sessionRouting: {},
            conversationState: {
                pending: { kind: "clarification", intent: "general_chat", prompt: "Tell me which spicy chicken items you want.", allowFollowUp: true },
                lastIntent: "general_chat",
            },
            async executeIntent(payload) {
                executed = payload
                return "tool-response"
            },
            async answerViaConfiguredMode(payload) {
                backendCalls++
                backendPayload = payload
                return "backend-response"
            },
        })

        assert("pending clarification can be rerouted as a structured menu turn", [
            ["tool route chosen", result.route === "customer_tool"],
            ["backend not called", backendCalls === 0],
            ["show_menu intent selected", executed && executed.intent.intent === "show_menu"],
            ["follow-up prompt included in effective message", executed && /Customer follow-up: High spicy\./.test(executed.effectiveMessage)],
        ])
    }

    {
        const { customerFlow } = loadCustomerFlowWithStubs({
            flowConfig: { backend: "openclaw" },
            routedIntent: { intent: "general_chat", filter: { query: "pricing" } },
        })
        let executed = 0
        let backendCalls = 0
        const result = await customerFlow.executeCustomerFlow({
            message: "tell me about pricing",
            phone: "p2",
            manifest: { intents: { general_chat: {}, support: {} } },
            domainPack: null,
            sessionRouting: {},
            conversationState: {},
            async executeIntent() {
                executed++
                return "tool-response"
            },
            async answerViaConfiguredMode() {
                backendCalls++
                return "backend-response"
            },
        })

        assert("backend mode uses backend for conversational intents", [
            ["backend route chosen", result.route === "customer_backend"],
            ["backend invoked once", backendCalls === 1],
            ["tool executor not invoked", executed === 0],
            ["response returned", result.response === "backend-response"],
        ])
    }

    {
        const { customerFlow } = loadCustomerFlowWithStubs({
            flowConfig: { backend: "myclaw" },
            routedIntent: { intent: "support", filter: {} },
        })
        let executed = null
        let backendCalls = 0
        const result = await customerFlow.executeCustomerFlow({
            message: "i need help",
            phone: "p3",
            manifest: { intents: { support: {}, general_chat: {} } },
            domainPack: null,
            sessionRouting: {},
            conversationState: {},
            async executeIntent(payload) {
                executed = payload
                return "support-response"
            },
            async answerViaConfiguredMode() {
                backendCalls++
                return "backend-response"
            },
        })

        assert("backend mode still keeps structured support intents on tool path", [
            ["tool route chosen", result.route === "customer_tool"],
            ["tool executor invoked", !!executed],
            ["support intent preserved", executed && executed.intent.intent === "support"],
            ["backend not invoked", backendCalls === 0],
        ])
    }

    {
        const { customerFlow } = loadCustomerFlowWithStubs({
            flowConfig: { backend: "openclaw" },
            routedIntent: { intent: "general_chat", filter: {} },
            preRoutePolicy: { allowed: false, reason: "out_of_domain", response: "OOD" },
        })
        let executed = 0
        let backendCalls = 0
        let backendPayload = null
        const result = await customerFlow.executeCustomerFlow({
            message: "tell me the capital of france please",
            phone: "p3b",
            manifest: { agent: { out_of_domain_message: "OOD" }, intents: { general_chat: {} } },
            domainPack: null,
            sessionRouting: {},
            conversationState: {},
            async executeIntent() {
                executed++
                return "tool-response"
            },
            async answerViaConfiguredMode(payload) {
                backendCalls++
                backendPayload = payload
                return "backend-response"
            },
        })

        assert("pre-route out-of-domain turns can be delegated to backend guidance", [
            ["backend route chosen", result.route === "customer_backend"],
            ["response preserved", result.response === "backend-response"],
            ["tool executor not invoked", executed === 0],
            ["backend invoked once", backendCalls === 1],
            ["policy context forwarded", backendPayload && backendPayload.policyContext && backendPayload.policyContext.blockedReason === "out_of_domain"],
        ])
    }

    {
        const { customerFlow } = loadCustomerFlowWithStubs({
            flowConfig: { backend: "openclaw" },
            routedIntent: { intent: "unknown", filter: {} },
            resolvedPolicy: { allowed: false, reason: "unknown_intent", response: "OOD" },
        })
        let executed = 0
        let backendCalls = 0
        let backendPayload = null
        const result = await customerFlow.executeCustomerFlow({
            message: "say something witty",
            phone: "p3c",
            manifest: { agent: { out_of_domain_message: "OOD" }, intents: { general_chat: {} } },
            domainPack: null,
            sessionRouting: {},
            conversationState: {},
            async executeIntent() {
                executed++
                return "tool-response"
            },
            async answerViaConfiguredMode(payload) {
                backendCalls++
                backendPayload = payload
                return "backend-response"
            },
        })

        assert("resolved policy conversational blocks can also use backend guidance", [
            ["backend route chosen", result.route === "customer_backend"],
            ["response preserved", result.response === "backend-response"],
            ["tool executor not invoked", executed === 0],
            ["backend invoked once", backendCalls === 1],
            ["resolved policy reason forwarded", backendPayload && backendPayload.policyContext && backendPayload.policyContext.blockedReason === "unknown_intent"],
        ])
    }

    {
        const { customerFlow, sessions } = loadCustomerFlowWithStubs({
            flowConfig: { backend: "openclaw" },
            routedIntent: { intent: "general_chat", filter: {} },
        })
        sessions.set("p4", { state: "open_cart" })
        let executed = null
        let backendCalls = 0
        const result = await customerFlow.executeCustomerFlow({
            message: "2 butter naan",
            phone: "p4",
            manifest: { intents: { place_order: {}, general_chat: {} } },
            domainPack: null,
            sessionRouting: { activeCartIntent: "place_order" },
            conversationState: {},
            async executeIntent(payload) {
                executed = payload
                return "cart-response"
            },
            async answerViaConfiguredMode() {
                backendCalls++
                return "backend-response"
            },
        })

        assert("active sessions bypass re-routing and stay on tool flow", [
            ["active session route chosen", result.route === "active_session"],
            ["cart intent used", executed && executed.intent.intent === "place_order"],
            ["backend not invoked", backendCalls === 0],
        ])
    }

    {
        const { customerFlow } = loadCustomerFlowWithStubs({
            flowConfig: { backend: "openclaw" },
            preRoutePolicy: { allowed: false, reason: "out_of_domain", response: "OOD" },
        })
        let executed = null
        let backendCalls = 0
        const result = await customerFlow.executeCustomerFlow({
            message: "all veg main course",
            phone: "p5",
            manifest: { agent: { out_of_domain_message: "OOD" }, intents: { place_order: {}, general_chat: {} } },
            domainPack: null,
            sessionRouting: {},
            conversationState: {
                selection: {
                    label: "Veg Main Course",
                    items: [
                        { name: "Veg Special Thali", price: 165 },
                        { name: "Rajma Chawal", price: 110 },
                    ],
                },
                pending: { kind: "selection_order", allowFollowUp: true },
                lastIntent: "show_menu",
            },
            async executeIntent(payload) {
                executed = payload
                return "selection-order-response"
            },
            async answerViaConfiguredMode() {
                backendCalls++
                return "backend-response"
            },
        })

        assert("selection follow-up bypasses domain gate and routes to place_order", [
            ["tool route chosen", result.route === "customer_tool"],
            ["place_order forced", executed && executed.intent.intent === "place_order"],
            ["backend not invoked", backendCalls === 0],
            ["response preserved", result.response === "selection-order-response"],
        ])
    }

    console.log(`\nPassed: ${passed}/${total}`)
    if (failed) process.exit(1)
}

main().catch(err => {
    console.error(err)
    process.exit(1)
})
