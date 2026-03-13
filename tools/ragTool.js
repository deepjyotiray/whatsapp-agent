"use strict"

const { retrieveContext } = require("../knowledge/rag")
const { generateResponse } = require("../gateway/responder")

async function execute(params, context, toolConfig) {
    const query = (params && params.query) || context.rawMessage || ""
    const ragData = await retrieveContext(query, toolConfig.db_path, toolConfig.vectordb_path)
    return await generateResponse(query, ragData, toolConfig.system_prompt)
}

module.exports = { execute }
