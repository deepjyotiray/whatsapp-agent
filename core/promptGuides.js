"use strict"

const fs   = require("fs")
const path = require("path")
const { getActiveWorkspace, workspacePath } = require("./workspace")

// ── Registry ──────────────────────────────────────────────────────────────────
// Any module can call registerGuide() at require-time.
// Guides registered here are "built-in" — always present for every workspace.

const builtInGuides = []

/**
 * Register a prompt guide.
 * @param {object} guide
 * @param {string} guide.id          Stable identifier (e.g. "admin-agent-system")
 * @param {string} guide.name        Human-readable label
 * @param {string} guide.description What the prompt does
 * @param {string} guide.source      File(s) that contain the prompt
 * @param {string} guide.editable    How to change it
 * @param {function} guide.render    (workspaceId) => string — returns the rendered prompt
 */
function registerGuide(guide) {
    if (!guide.id || !guide.render) throw new Error("Guide must have id and render()")
    const existing = builtInGuides.findIndex(g => g.id === guide.id)
    if (existing >= 0) builtInGuides[existing] = guide
    else builtInGuides.push(guide)
}

// ── Workspace custom guides ───────────────────────────────────────────────────
// Stored in data/workspaces/<id>/config/prompt-guides.json
// Array of { id, name, description, source, editable, prompt }

const CUSTOM_FILE = "config/prompt-guides.json"

function customGuidesPath(workspaceId) {
    return workspacePath(workspaceId, CUSTOM_FILE)
}

function loadCustomGuides(workspaceId) {
    try {
        const raw = fs.readFileSync(customGuidesPath(workspaceId), "utf8")
        const arr = JSON.parse(raw)
        return Array.isArray(arr) ? arr : []
    } catch { return [] }
}

function saveCustomGuides(workspaceId, guides) {
    const p = customGuidesPath(workspaceId)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(guides, null, 2), "utf8")
    return guides
}

function addCustomGuide(workspaceId, guide) {
    if (!guide.id || !guide.prompt) throw new Error("Custom guide must have id and prompt")
    const guides = loadCustomGuides(workspaceId)
    const idx = guides.findIndex(g => g.id === guide.id)
    const entry = {
        id: guide.id,
        name: guide.name || guide.id,
        description: guide.description || "",
        source: guide.source || "custom",
        editable: guide.editable || "POST /setup/agent/prompts",
        prompt: guide.prompt,
    }
    if (idx >= 0) guides[idx] = entry
    else guides.push(entry)
    saveCustomGuides(workspaceId, guides)
    return entry
}

function removeCustomGuide(workspaceId, guideId) {
    const guides = loadCustomGuides(workspaceId)
    const filtered = guides.filter(g => g.id !== guideId)
    if (filtered.length === guides.length) return false
    saveCustomGuides(workspaceId, filtered)
    return true
}

// ── Public API ────────────────────────────────────────────────────────────────

function getPromptGuides(workspaceId) {
    const wid = workspaceId || getActiveWorkspace()
    const rendered = builtInGuides.map(g => ({
        id: g.id,
        name: g.name,
        description: g.description,
        source: g.source,
        editable: g.editable,
        type: "built-in",
        prompt: g.render(wid),
    }))
    const custom = loadCustomGuides(wid).map(g => ({ ...g, type: "custom" }))
    return { workspaceId: wid, guides: [...rendered, ...custom] }
}

function getPromptGuide(guideId, workspaceId) {
    const all = getPromptGuides(workspaceId)
    const guide = all.guides.find(g => g.id === guideId)
    if (!guide) return null
    return { workspaceId: all.workspaceId, guide }
}

module.exports = {
    registerGuide,
    getPromptGuides,
    getPromptGuide,
    addCustomGuide,
    removeCustomGuide,
}
