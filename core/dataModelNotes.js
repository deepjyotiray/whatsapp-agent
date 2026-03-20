"use strict"

const fs       = require("fs")
const path     = require("path")
const Database = require("better-sqlite3")
const { workspacePath } = require("./workspace")
const { complete }      = require("../providers/llm")
const { loadProfile }   = require("../setup/profileService")
const settings = require("../config/settings.json")

const NOTES_FILE = "config/data-model-notes.md"

function notesPath(workspaceId) {
    return workspacePath(workspaceId, NOTES_FILE)
}

function loadNotes(workspaceId) {
    const p = notesPath(workspaceId)
    try { return fs.readFileSync(p, "utf8") } catch { return "" }
}

function saveNotes(workspaceId, text) {
    const p = notesPath(workspaceId)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, text, "utf8")
    return text
}

// ── Schema introspection ──────────────────────────────────────────────────────

function introspectSchema(dbPath) {
    const db = new Database(dbPath, { readonly: true })
    try {
        const tables = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).all().map(t => t.name)

        return tables.map(t => {
            const cols = db.prepare(`PRAGMA table_info("${t}")`).all()
            const count = db.prepare(`SELECT COUNT(*) as n FROM "${t}"`).get().n
            const sample = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid DESC LIMIT 3`).all()
            return { table: t, columns: cols, rowCount: count, sample }
        })
    } finally { db.close() }
}

function schemaToText(tables) {
    return tables.map(t => {
        const colDefs = t.columns.map(c =>
            `  ${c.name} ${c.type || "TEXT"}${c.pk ? " PK" : ""}${c.dflt_value != null ? ` DEFAULT ${c.dflt_value}` : ""}`
        ).join("\n")
        const sampleStr = t.sample.length
            ? t.sample.map(r => "  " + JSON.stringify(r)).join("\n")
            : "  (empty)"
        return `TABLE ${t.table} (${t.rowCount} rows)\n${colDefs}\nSample:\n${sampleStr}`
    }).join("\n\n")
}

// ── LLM generation ────────────────────────────────────────────────────────────

async function generateNotes(workspaceId) {
    const profile = loadProfile(workspaceId)
    const dbPath  = profile.dbPath || settings.admin?.db_path
    if (!dbPath || !fs.existsSync(dbPath)) {
        return saveNotes(workspaceId, "<!-- No database configured for this workspace -->")
    }

    const tables    = introspectSchema(dbPath)
    const schemaStr = schemaToText(tables)
    const biz       = profile.businessName || workspaceId

    const prompt = `You are a database documentation expert.

Below is the full SQLite schema and sample rows for "${biz}".

${schemaStr}

Write concise DATA MODEL NOTES that an AI agent will use as a reference when choosing tools and writing SQL queries. The notes must:

1. List every table with a one-line purpose description
2. Flag any non-obvious column semantics (e.g. a column named "expense" that also stores income, or a status column with specific allowed values)
3. Document EVERY date/time column and its exact format (detect from sample data — e.g. DD/MM/YYYY vs YYYY-MM-DD vs ISO 8601)
4. Note any tables that serve dual purposes (e.g. one table storing both expenses and income)
5. List relationships between tables (foreign keys, shared columns)
6. Call out any gotchas an AI might trip on (e.g. "there is no separate income table", "use column X not Y for status")
7. For columns with enumerated values (statuses, types), list the observed values from sample data

Output ONLY the notes in markdown, no preamble. Start with "## Data Model Notes".
Keep it under 80 lines. Be precise, not verbose.`

    let text
    try {
        text = await complete(prompt)
    } catch {
        // Fallback: generate a basic schema dump without LLM
        text = `## Data Model Notes\n\n_Auto-generated schema dump (LLM unavailable)_\n\n${schemaStr}`
    }

    if (!text || text.length < 20) {
        text = `## Data Model Notes\n\n_Auto-generated schema dump (LLM unavailable)_\n\n${schemaStr}`
    }

    return saveNotes(workspaceId, text)
}

module.exports = { loadNotes, saveNotes, generateNotes, notesPath }
