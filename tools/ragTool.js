"use strict"

const { retrieveContext }  = require("../knowledge/rag")
const { generateResponse } = require("../gateway/responder")

async function execute(filter, context, toolConfig) {
    const query = context.rawMessage || ""
    const data  = await retrieveContext(query, toolConfig.db_path, null, filter)
    return await generateResponse(query, data, toolConfig.system_prompt)
}

module.exports = { execute }
