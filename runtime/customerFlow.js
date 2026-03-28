"use strict"

const logger = require("../gateway/logger")
const cartStore = require("../tools/cartStore")
const { routeCustomerMessage } = require("../gateway/customerRouter")
const { getFlowConfig } = require("../providers/llm")
const { resolveFollowUp } = require("./followUpResolver")
const { buildResolvedRequest } = require("./resolvedRequest")
const { decideCustomerExecution, getCustomerExecutionConfig } = require("./flowOrchestrator")
const { getActiveWorkspace } = require("../core/workspace")
const { evaluateCustomerPreRoutePolicy, evaluateCustomerResolvedPolicy } = require("./customerPolicy")
const { buildActiveCustomerState, resolveSelectionOrderIntent, resolvePendingClarification } = require("./customerState")
const { planCustomerTurn } = require("./customerPlanner")
const { loadProfile } = require("../setup/profileService")
const { hydrateCustomerProfile } = require("./customerProfileHydrator")

function isSupportMenuReply(message) {
    const text = String(message || "").trim()
    return text === "0" || /^[1-5]$/.test(text)
}

function buildCustomerTurn({ message, phone, conversationState, domainPack, workspaceId }) {
    const profile = loadProfile(workspaceId)
    const hydratedProfile = hydrateCustomerProfile({
        workspaceId,
        phone,
        dbPath: profile.dbPath,
    })
    const activeConversationState = buildActiveCustomerState({
        workspaceId,
        phone,
        conversationState,
        message,
        hydratedProfile,
    })
    const statefulResolution = resolveSelectionOrderIntent(message, activeConversationState)
        || resolvePendingClarification(message, activeConversationState)
    const resolved = resolveFollowUp({
        flow: "customer",
        message,
        conversationState: activeConversationState,
        domainPack,
    })
    const effectiveMessage = statefulResolution?.message || resolved.message || message
    const resolvedRequest = buildResolvedRequest({
        flow: "customer",
        originalMessage: message,
        effectiveMessage,
        conversationState: activeConversationState,
        resolution: resolved,
    })

    if (statefulResolution?.intentOverride) {
        resolvedRequest.lastIntent = statefulResolution.intentOverride
        resolvedRequest.selectionAction = statefulResolution.selectionAction || null
        resolvedRequest.policyBypass = !!statefulResolution.bypassPreRoutePolicy
    }

    if (resolved.resolved) {
        logger.info({
            phone,
            originalMessage: message,
            effectiveMessage,
            reason: resolved.reason,
            confidence: resolved.confidence,
        }, "chain: follow-up resolved")
    }

    return { resolved, effectiveMessage, resolvedRequest, conversationState: activeConversationState, statefulResolution }
}

async function resolveCustomerRoute({ message, manifest, resolvedRequest, phone }) {
    try {
        const { getCachedIntent } = require("./previewEngine")
        const cached = getCachedIntent(phone, message)
        if (cached) {
            const routedIntent = { intent: cached.intent, filter: cached.filter || {} }
            logger.info({ phone, intent: routedIntent.intent, source: "cache" }, "chain: intent parsed (cached)")
            return routedIntent
        }

        const routedIntent = await routeCustomerMessage(message, manifest, { resolvedRequest })
        logger.info({ phone, intent: routedIntent.intent }, "chain: intent parsed")
        return routedIntent
    } catch {
        return { intent: "general_chat", filter: {} }
    }
}

async function executeCustomerFlow(options) {
    const {
        message,
        phone,
        manifest,
        domainPack,
        sessionRouting,
        conversationState,
        executeIntent,
        answerViaConfiguredMode,
    } = options

    const workspaceId = getActiveWorkspace()
    const turn = buildCustomerTurn({ message, phone, conversationState, domainPack, workspaceId })
    const customerFlowCfg = getFlowConfig("customer")
    const customerExecutionCfg = getCustomerExecutionConfig(customerFlowCfg)
    const activeSession = cartStore.get(phone)
    const activeSupport = cartStore.get(`support:${phone}`)
    const backendEnabled = !!(customerFlowCfg?.backend && customerFlowCfg.backend !== "direct")
    const canUseConversationalBackend = backendEnabled && !!customerExecutionCfg?.backendCapabilities?.conversational

    if (activeSession && activeSession.state === "support_handoff") {
        cartStore.clear(phone)
        const response = await executeIntent({
            intent: { intent: "support", filter: {} },
            effectiveMessage: turn.effectiveMessage,
            resolvedMeta: turn.resolved,
            resolvedRequest: turn.resolvedRequest,
            originalMessage: message,
        })
        return { response, route: "support_handoff", turn }
    }

    if (activeSession) {
        const cartIntent = sessionRouting.activeCartIntent || Object.keys(manifest.intents)[0] || "general_chat"
        const response = await executeIntent({
            intent: { intent: cartIntent, filter: {} },
            effectiveMessage: turn.effectiveMessage,
            resolvedMeta: turn.resolved,
            resolvedRequest: turn.resolvedRequest,
            originalMessage: message,
        })
        return { response, route: "active_session", turn }
    }

    if (activeSupport) {
        if (activeSupport.state === "menu" && !isSupportMenuReply(message)) {
            try {
                const reroute = await routeCustomerMessage(turn.effectiveMessage, manifest, { resolvedRequest: turn.resolvedRequest })
                if (reroute.intent && reroute.intent !== "support") {
                    cartStore.clear(`support:${phone}`)
                } else {
                    const response = await executeIntent({
                        intent: { intent: "support", filter: {} },
                        effectiveMessage: turn.effectiveMessage,
                        resolvedMeta: turn.resolved,
                        resolvedRequest: turn.resolvedRequest,
                        originalMessage: message,
                    })
                    return { response, route: "active_support", turn }
                }
            } catch {
                cartStore.clear(`support:${phone}`)
            }
        } else {
            const response = await executeIntent({
                intent: { intent: "support", filter: {} },
                effectiveMessage: turn.effectiveMessage,
                resolvedMeta: turn.resolved,
                resolvedRequest: turn.resolvedRequest,
                originalMessage: message,
            })
            return { response, route: "active_support", turn }
        }
    }

    const preRoutePolicy = evaluateCustomerPreRoutePolicy({
        message: turn.effectiveMessage,
        manifest,
        workspaceId,
        stateContext: turn.statefulResolution,
    })
    if (!preRoutePolicy.allowed) {
        if (preRoutePolicy.reason === "out_of_domain" && canUseConversationalBackend) {
            const response = await answerViaConfiguredMode({
                resolvedRequest: turn.resolvedRequest,
                phone,
                routedIntent: { intent: "general_chat", filter: {} },
                conversationState: turn.conversationState,
                policyContext: {
                    blockedReason: preRoutePolicy.reason,
                },
            })
            return {
                response,
                route: "customer_backend",
                turn,
                routedIntent: { intent: "general_chat", filter: {} },
                policy: preRoutePolicy,
                executionPlan: { mode: "backend", reason: "customer_policy_guided_backend", intent: "general_chat" },
                executionConfig: customerExecutionCfg,
            }
        }
        const plannerDecision = await planCustomerTurn({
            message: turn.effectiveMessage,
            conversationState: turn.conversationState,
            manifest,
            blockedReason: preRoutePolicy.reason,
        })
        if (plannerDecision.mode === "respond") {
            return {
                response: plannerDecision.response,
                route: "customer_planner",
                turn,
                executionConfig: customerExecutionCfg,
                plannerDecision,
                routedIntent: { intent: "general_chat", filter: {} },
            }
        }
        logger.info({ phone, reason: preRoutePolicy.reason }, "chain: customer pre-route policy blocked")
        return { response: preRoutePolicy.response, route: "policy_blocked", turn, policy: preRoutePolicy, executionConfig: customerExecutionCfg }
    }

    const routedIntent = turn.statefulResolution?.intentOverride
        ? { intent: turn.statefulResolution.intentOverride, filter: {} }
        : await resolveCustomerRoute({
            message: turn.effectiveMessage,
            manifest,
            resolvedRequest: turn.resolvedRequest,
            phone,
        })

    const resolvedPolicy = evaluateCustomerResolvedPolicy({
        manifest,
        routedIntent,
        workspaceId,
        domainPack,
    })
    if (!resolvedPolicy.allowed) {
        if ((resolvedPolicy.reason === "unknown_intent" || resolvedPolicy.reason === "not_in_allowlist") && canUseConversationalBackend) {
            const response = await answerViaConfiguredMode({
                resolvedRequest: turn.resolvedRequest,
                phone,
                routedIntent: { intent: "general_chat", filter: {} },
                conversationState: turn.conversationState,
                policyContext: {
                    blockedReason: resolvedPolicy.reason,
                    routedIntent: routedIntent.intent,
                },
            })
            return {
                response,
                route: "customer_backend",
                turn,
                routedIntent: { intent: "general_chat", filter: {} },
                policy: resolvedPolicy,
                executionPlan: { mode: "backend", reason: "customer_resolved_policy_guided_backend", intent: "general_chat" },
                executionConfig: customerExecutionCfg,
            }
        }
        logger.info({ phone, reason: resolvedPolicy.reason, intent: routedIntent.intent }, "chain: customer resolved policy blocked")
        return { response: resolvedPolicy.response, route: "policy_blocked", turn, routedIntent, policy: resolvedPolicy, executionConfig: customerExecutionCfg }
    }

    const executionPlan = decideCustomerExecution({
        flowConfig: customerFlowCfg,
        routedIntent,
        manifest,
    })
    logger.info({ phone, mode: executionPlan.mode, reason: executionPlan.reason, intent: executionPlan.intent }, "chain: customer flow orchestrated")

    turn.resolvedRequest.lastIntent = routedIntent.intent
    turn.resolvedRequest.appliedFilters = routedIntent.filter || turn.resolvedRequest.appliedFilters

    if (executionPlan.mode === "backend") {
        const response = await answerViaConfiguredMode({
            resolvedRequest: turn.resolvedRequest,
            phone,
            routedIntent,
            conversationState: turn.conversationState,
        })
        return { response, route: "customer_backend", turn, routedIntent, executionPlan, executionConfig: customerExecutionCfg }
    }

    let intent = routedIntent.intent
    if (!manifest.intents[intent]) {
        intent = manifest.intents.general_chat ? "general_chat" : Object.keys(manifest.intents)[0]
    }

    const response = await executeIntent({
        intent: { intent, filter: routedIntent.filter || {} },
        effectiveMessage: turn.effectiveMessage,
        resolvedMeta: turn.resolved,
        resolvedRequest: turn.resolvedRequest,
        conversationState: turn.conversationState,
        originalMessage: message,
    })
    return { response, route: "customer_tool", turn, routedIntent: { intent, filter: routedIntent.filter || {} }, executionPlan, executionConfig: customerExecutionCfg }
}

module.exports = {
    buildCustomerTurn,
    resolveCustomerRoute,
    executeCustomerFlow,
}
