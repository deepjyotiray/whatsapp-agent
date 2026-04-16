"use strict"

const Database = require("better-sqlite3")
const { complete } = require("../providers/llm")
const logger = require("../gateway/logger")

const MAX_RAG_CHARS = 4000
const CACHE_TTL_MS = 60 * 1000
const EMPTY_CACHE_TTL_MS = 10 * 60 * 1000
const _resultCache = new Map()

function getDb(dbPath) {
    const db = new Database(dbPath, { readonly: true })
    db.pragma("busy_timeout = 5000")
    return db
}

function discoverSearchableTables(db) {
    const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all().map(t => t.name)

    const searchable = []
    for (const table of tables) {
        const cols = db.prepare(`PRAGMA table_info("${table}")`).all()
        const textCols = cols.filter(c => /text|varchar|char/i.test(c.type || "TEXT"))
        if (textCols.length) {
            searchable.push({ table, textCols: textCols.map(c => c.name), allCols: cols.map(c => c.name) })
        }
    }
    return searchable
}

function keywordSearch(db, tables, query, filter = {}) {
    const words = (query || "").toLowerCase().split(/\s+/).filter(w => w.length > 1)
    const STOP_WORDS = new Set(["show", "me", "the", "any", "do", "you", "have", "what", "is", "are",
        "items", "options", "anything", "in", "under", "below", "above", "give", "list",
        "all", "your", "our", "available", "please", "can", "get", "find", "search"])
    const searchWords = words.filter(w => !STOP_WORDS.has(w))
    if (!searchWords.length && !Object.keys(filter).length) {
        return { rows: [], source: "no_query" }
    }

    const allRows = []
    for (const { table, textCols, allCols } of tables) {
        const conditions = []
        const params = []

        for (const word of searchWords) {
            const wordConditions = textCols.map(col => `LOWER("${col}") LIKE ?`)
            conditions.push(`(${wordConditions.join(" OR ")})`)
            for (let i = 0; i < textCols.length; i++) params.push(`%${word}%`)
        }

        for (const [key, val] of Object.entries(filter)) {
            if (val === null || val === undefined) continue
            if (!allCols.includes(key)) continue
            if (typeof val === "boolean") {
                conditions.push(`"${key}" = ?`)
                params.push(val ? 1 : 0)
            } else if (typeof val === "number") {
                conditions.push(`"${key}" <= ?`)
                params.push(val)
            } else if (typeof val === "string" && val.length) {
                conditions.push(`LOWER("${key}") LIKE ?`)
                params.push(`%${val.toLowerCase()}%`)
            }
        }

        if (!conditions.length) continue

        const sql = `SELECT * FROM "${table}" WHERE ${conditions.join(" AND ")} LIMIT 30`
        try {
            const rows = db.prepare(sql).all(...params)
            for (const row of rows) {
                let score = 0
                const rowText = Object.values(row).join(" ").toLowerCase()
                for (const w of searchWords) {
                    if (rowText.includes(w)) score++
                }
                allRows.push({ ...row, _table: table, _score: score })
            }
        } catch (err) {
            logger.warn({ err: err.message, table, sql }, "genericRagTool: query failed for table")
        }
    }

    allRows.sort((a, b) => b._score - a._score)
    return { rows: allRows.slice(0, 30), source: "keyword" }
}

function formatResults(rows) {
    if (!rows.length) return ""
    return rows.map(row => {
        const { _table, _score, ...data } = row
        return Object.entries(data)
            .filter(([, v]) => v !== null && v !== undefined && v !== "")
            .map(([k, v]) => `${k}: ${v}`)
            .join(" | ")
    }).join("\n")
}

function normalizeQuery(query = "") {
    return String(query || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
}

function buildCacheKey(dbPath, query, filter) {
    return JSON.stringify({
        dbPath: String(dbPath || ""),
        query: normalizeQuery(query),
        filter: filter || {},
    })
}

function getCachedResult(key) {
    const entry = _resultCache.get(key)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
        _resultCache.delete(key)
        return null
    }
    return entry.value
}

function setCachedResult(key, value, ttlMs) {
    _resultCache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
    })
    return value
}

async function execute(filter, context, toolConfig) {
    const { db_path, system_prompt } = toolConfig
    if (!db_path) return "Database not configured."

    const query = context.resolvedRequest?.effectiveMessage || context.rawMessage || ""
    const effectiveFilter = context.resolvedRequest?.appliedFilters || filter
    const cacheKey = buildCacheKey(db_path, query, effectiveFilter)
    const cached = getCachedResult(cacheKey)
    if (cached) return cached

    const db = getDb(db_path)
    try {
        const tables = discoverSearchableTables(db)
        if (!tables.length) return "No searchable data found."

        const { rows } = keywordSearch(db, tables, query, effectiveFilter)

        if (!rows.length) {
            return setCachedResult(cacheKey, "Sorry, nothing matched your query.", EMPTY_CACHE_TTL_MS)
        }

        const formatted = formatResults(rows)
        if (!formatted) {
            return setCachedResult(cacheKey, "Sorry, nothing matched your query.", EMPTY_CACHE_TTL_MS)
        }

        const trimmed = formatted.length > MAX_RAG_CHARS
            ? formatted.slice(0, MAX_RAG_CHARS) + "\n\n(data truncated)"
            : formatted

        if (context?.skipLlm) {
            return setCachedResult(cacheKey, trimmed, CACHE_TTL_MS)
        }

        const defaultPrompt = `You are a helpful business assistant.
Answer using ONLY the provided data. Be concise and formatted for WhatsApp.
Do NOT make up information. If nothing matches, say so clearly.
Only include results directly relevant to what was asked.`

        const prompt = `${system_prompt || defaultPrompt}

Customer question: ${query}

Retrieved data:
${trimmed}

Answer:`

        try {
            const text = await complete(prompt, {
                flow: context?.flow || "customer",
                llmConfig: context?.llmConfig,
            })
            return setCachedResult(cacheKey, text || formatted, CACHE_TTL_MS)
        } catch {
            return setCachedResult(cacheKey, formatted, CACHE_TTL_MS)
        }
    } catch (err) {
        logger.error({ err }, "genericRagTool: execute failed")
        return "Something went wrong while searching. Please try again."
    } finally {
        try { db.close() } catch {}
    }
}

module.exports = { execute }
