const lancedb = require("@lancedb/lancedb")

async function retrieveContext(query){

    const db = await lancedb.connect("./vectordb")
    const table = await db.openTable("restaurant")

    const results = await table.query().limit(1).toArray()

    if (!results.length) {
        return "Menu not available."
    }

    return String(results[0].text)
}

module.exports = { retrieveContext }