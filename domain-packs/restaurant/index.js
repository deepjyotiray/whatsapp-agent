"use strict"

const menuRag           = require("./tools/menuRag")
const orderLookup       = require("./tools/orderLookup")
const orderCreate       = require("./tools/orderCreate")
const supportNotify     = require("./tools/supportNotify")
const websiteRedirect   = require("./tools/websiteRedirect")
const adminTools         = require("./admin-tools")

module.exports = {
    name: "restaurant",
    domain: "food",
    version: "1.0.0",
    description: "Restaurant / food-delivery domain pack",

    resolveFollowUp({ flow, message, conversationState }) {
        if (flow !== "customer") return null
        const text = String(message || "").trim().toLowerCase()
        const topic = conversationState?.topic?.label
        if (!topic) return null

        if (/^(add one|add 1|book one)$/i.test(text)) {
            return {
                message: `add one ${topic}`,
                reason: "restaurant_add_from_active_topic",
                confidence: 0.74,
            }
        }

        return null
    },

    extractConversationState({ flow, message, resolvedMessage, intent, filters, conversationState }) {
        const query = typeof filters?.query === "string" && filters.query.trim()
            ? filters.query.trim()
            : null

        if (flow === "customer") {
            if (intent === "show_menu") {
                return {
                    task: "browse_catalog",
                    route: "customer_menu",
                    topic: query
                        ? { label: query, source: "filter", confidence: 0.88 }
                        : conversationState?.topic || null,
                }
            }

            if (intent === "place_order") {
                return {
                    task: "place_order",
                    route: "customer_order",
                }
            }
        }

        if (flow === "admin") {
            return {
                route: "admin",
            }
        }

        return null
    },

    // tool type name → handler module (each exports execute())
    toolTypes: {
        menu_rag:           menuRag,
        order_lookup:       orderLookup,
        order_create:       orderCreate,
        support_notify:     supportNotify,
        website_redirect:   websiteRedirect,
    },

    // heuristic keywords for customerRouter
    heuristics: {
        order_or_menu: ["menu", "dish", "dishes", "food", "eat", "hungry", "price", "veg", "thali", "biryani", "order", "delivery", "status", "track", "invoice", "receipt", "bill", "payment", "buy", "checkout", "cart", "place order"],
        support:       ["help", "support", "complaint", "wrong", "missing", "issue", "problem", "refund", "late", "delay", "bad", "quality"],
    },

    heuristicIntentMap: {
        order_or_menu: "order_or_menu",
        support:       "support",
    },

    // filter schema for intentParser
    filterSchema: {
        veg:         { type: "boolean", description: "true = vegetarian only" },
        max_price:   { type: "number",  description: "maximum price" },
        max_calories:{ type: "number",  description: "maximum calories" },
        min_protein: { type: "number",  description: "minimum protein in grams" },
        max_fat:     { type: "number",  description: "maximum fat in grams" },
    },

    filterExamples: [
        { input: "show me veg items under 200", output: { veg: true, max_price: 200 } },
        { input: "high protein meals",          output: { min_protein: 20 } },
    ],

    // admin tool definitions (OpenAI function-calling format)
    adminToolDefinitions: adminTools.toolDefinitions,

    // admin tool dispatcher — returns result string or null if not handled
    dispatchAdminTool: adminTools.dispatch,

    // admin context builder — restaurant-specific business summary
    buildAdminContext: adminTools.buildAdminContext,

    // vision prompt and handler for admin image processing
    visionPrompt: adminTools.visionPrompt,
    insertVisionEntries: adminTools.insertVisionEntries,

    // risk classification for preview engine
    riskMap: {
        menu_rag: "low",
        order_lookup: "medium",
        order_create: "high",
        restaurant_support: "low",
    },

    // session routing config
    sessionRouting: {
        activeCartIntent: "place_order",
    },
}
