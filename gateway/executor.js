"use strict"

const menuTool = require("../tools/menuTool")
const authTool = require("../tools/authTool")
const orderTool = require("../tools/orderTool")
const logger = require("./logger")

const TOOL_MAP = {
    greet: greetHandler,
    show_menu: menuTool.execute,
    help: helpHandler,
    login: authTool.execute,
    order_status: orderTool.execute
}

async function greetHandler() {
    return "👋 Welcome to Ray's Home Kitchen!\n\nI can help you with:\n• View today's menu\n• Check your order status\n• Login to your account\n\nWhat would you like?"
}

async function helpHandler() {
    return "You can ask me to:\n• Show the menu\n• Check your order status\n• Login to your account"
}

/**
 * Routes a validated intent to the correct tool.
 * The LLM is never called from here.
 *
 * @param {{ intent: string, parameters: object }} intent
 * @param {object} context - { phone }
 * @returns {Promise<string>}
 */
async function execute(intent, context) {
    const handler = TOOL_MAP[intent.intent]

    if (!handler) {
        logger.warn({ intent: intent.intent }, "executor: no handler for intent")
        return "This feature is not available yet."
    }

    logger.info({ intent: intent.intent, phone: context.phone }, "executor: dispatching")

    return await handler(intent.parameters, context)
}

module.exports = { execute }
