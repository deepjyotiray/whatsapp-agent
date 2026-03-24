"use strict"

/**
 * Context Pipeline: refactors how context is built and passed.
 * Input -> Context Builder -> Provider Adapter -> Model
 */

const { getActiveWorkspace } = require("../core/workspace")
const { loadProfile } = require("../setup/profileService")

function buildContext(flow, context) {
    const lines = []
    
    // 1. Static/System context (if defined)
    if (context.systemContext) {
        lines.push(context.systemContext)
    }

    // 2. Profile facts
    if (context.profileFacts) {
        lines.push(`=== BUSINESS PROFILE ===`)
        lines.push(context.profileFacts)
        lines.push("")
    }

    // 3. Dynamic context (catalog, db, etc)
    if (context.dynamicContext) {
        lines.push(`=== DYNAMIC CONTEXT ===`)
        lines.push(context.dynamicContext)
        lines.push("")
    }

    // 4. Session history
    if (Array.isArray(context.history) && context.history.length > 0) {
        lines.push(`=== CONVERSATION HISTORY ===`)
        context.history.slice(-8).forEach(turn => {
            lines.push(`${turn.role}: ${turn.text}`)
        })
        lines.push("")
    }

    return lines.join("\n")
}

/**
 * Creates a structured prompt/messages for the adapter.
 */
function prepareRequest(prompt, flow, context) {
    const fullContext = buildContext(flow, context)
    
    // For cloud providers that support 'system' role
    return [
        { role: "system", content: fullContext },
        { role: "user", content: prompt }
    ]
}

module.exports = {
    buildContext,
    prepareRequest
}
