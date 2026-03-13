"use strict"

const { retrieveContext } = require("../knowledge/rag")
const { generateResponse } = require("../gateway/responder")

async function execute(params, context) {
    const query = (params && params.query) || context.rawMessage || ""

    // Step 1: RAG fetches relevant data from DB (deterministic)
    const ragData = await retrieveContext(query)

    // Step 2: LLM formats a focused response from that data (no tool access)
    return await generateResponse(query, ragData)
}

module.exports = { execute }
