"use strict"

const logger = require("../gateway/logger")

const TOOL_REGISTRY = {
    business_chat: require("../tools/businessChatTool"),
    rag:          require("../tools/ragTool"),
    sqlite:       require("../tools/sqliteTool"),
    support:      require("../tools/supportTool"),
    order_create: require("../tools/orderCreateTool"),
}

async function execute(manifest, intent, context) {
    const intentConfig = manifest.intents[intent.intent]
    if (!intentConfig) {
        logger.warn({ intent: intent.intent }, "executor: no intent config")
        return manifest.agent.error_message || "Something went wrong."
    }

    const toolName   = intentConfig.tool
    const toolConfig = manifest.tools[toolName]
    if (!toolConfig) {
        logger.warn({ toolName }, "executor: tool not in manifest")
        return manifest.agent.error_message || "Something went wrong."
    }

    const tool = TOOL_REGISTRY[toolConfig.type]
    if (!tool) {
        logger.warn({ type: toolConfig.type }, "executor: unknown tool type")
        return manifest.agent.error_message || "Something went wrong."
    }

    logger.info({ intent: intent.intent, tool: toolName }, "executor: dispatching")
    // pass filter as params so all tools receive it consistently
    return await tool.execute(intent.filter || {}, context, toolConfig)
}

module.exports = { execute }
