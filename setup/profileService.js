"use strict"

const fs = require("fs")
const path = require("path")
const { assemble } = require("./ingest")
const { generate } = require("./generate")
const {
    ROOT_DIR,
    workspaceIdFromProfile,
    workspacePath,
    listWorkspaceIds,
    getActiveWorkspace,
    setActiveWorkspace,
    ensureWorkspace,
    migrateLegacyProfile,
} = require("../core/workspace")

const DEFAULT_PROFILE = {
    businessName: "",
    businessType: "",
    brandTagline: "",
    brandVoice: "",
    targetAudience: "",
    description: "",
    website: "",
    websiteNotes: "",
    countryCode: "91",
    currency: "₹",
    language: "English",
    timezone: "Asia/Kolkata",
    contactEmail: "",
    contactPhone: "",
    address: "",
    serviceAreas: "",
    businessHours: "",
    holidays: "",
    offerings: "",
    catalogNotes: "",
    pricingNotes: "",
    fulfillmentMode: "",
    orderingFlow: "",
    bookingFlow: "",
    faqSeed: "",
    supportPolicy: "",
    escalationPolicy: "",
    refundPolicy: "",
    customerDataRules: "",
    complianceNotes: "",
    paymentMethods: "",
    integrations: "",
    knowledgeUrls: "",
    launchGoals: "",
    adminPhone: "",
    adminKeyword: "admin",
    adminPin: "",
    openaiKey: "",
    dbPath: "",
    ticketsFile: "",
    extraContext: "",
    escalationPhone: "",
    scrapeWebsite: true,
}

function ensureDir(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
}

function resolveProfilePathValue(value = "") {
    const raw = String(value || "").trim()
    if (!raw) return ""
    return path.isAbsolute(raw) ? raw : path.resolve(ROOT_DIR, raw)
}

function resolveProfilePaths(profile = {}) {
    return {
        ...profile,
        dbPath: resolveProfilePathValue(profile.dbPath),
        ticketsFile: resolveProfilePathValue(profile.ticketsFile),
    }
}

function profilePath(workspaceId) {
    return workspacePath(workspaceId, "profile.json")
}

function loadProfile(workspaceId = getActiveWorkspace()) {
    migrateLegacyProfile(DEFAULT_PROFILE)
    const targetPath = profilePath(workspaceId)
    if (!fs.existsSync(targetPath)) return resolveProfilePaths({ ...DEFAULT_PROFILE, workspaceId })
    try {
        return resolveProfilePaths({ ...DEFAULT_PROFILE, workspaceId, ...JSON.parse(fs.readFileSync(targetPath, "utf8")) })
    } catch {
        return resolveProfilePaths({ ...DEFAULT_PROFILE, workspaceId })
    }
}

function saveProfile(profile, workspaceId = null) {
    const resolvedWorkspace = workspaceIdFromProfile({ ...profile, workspaceId: workspaceId || profile.workspaceId || getActiveWorkspace() })
    const existing = loadProfile(resolvedWorkspace)
    const next = { ...DEFAULT_PROFILE, ...existing, ...profile, workspaceId: resolvedWorkspace }
    const targetPath = profilePath(resolvedWorkspace)
    ensureDir(targetPath)
    fs.writeFileSync(targetPath, JSON.stringify(next, null, 2))
    setActiveWorkspace(resolvedWorkspace)
    return next
}

function normalizeProfile(input = {}) {
    return {
        ...DEFAULT_PROFILE,
        ...input,
        scrapeWebsite: input.scrapeWebsite !== false,
    }
}

async function generateDraftFromProfile(input) {
    const profile = normalizeProfile(input)
    const workspaceId = workspaceIdFromProfile(profile)
    ensureWorkspace(workspaceId, { profile: { ...DEFAULT_PROFILE, ...profile, workspaceId } })
    const assembled = await assemble({
        ...profile,
        workspaceId,
        dbPath: profile.dbPath || null,
        ticketsFile: profile.ticketsFile || null,
        extraContext: profile.extraContext || null,
        scrapeWebsite: !!profile.scrapeWebsite,
    })
    const result = await generate({
        ...profile,
        workspaceId,
        dbPath: profile.dbPath || null,
        ticketsFile: profile.ticketsFile || null,
        extraContext: profile.extraContext || null,
        context: assembled,
        escalationPhone: profile.escalationPhone || profile.adminPhone,
    })
    return result
}

function listDraftFiles(workspaceId = getActiveWorkspace()) {
    const draftDir = path.join(ROOT_DIR, "draft", "workspaces", workspaceId)
    if (!fs.existsSync(draftDir)) return []

    function walk(dir) {
        return fs.readdirSync(dir).flatMap(entry => {
            const full = path.join(dir, entry)
            return fs.statSync(full).isDirectory() ? walk(full) : [full]
        })
    }

    return walk(draftDir).map(file => path.relative(ROOT_DIR, file))
}

function promoteDraft(workspaceId = getActiveWorkspace()) {
    const draftDir = path.join(ROOT_DIR, "draft", "workspaces", workspaceId)
    if (!fs.existsSync(draftDir)) throw new Error("No draft found. Generate a draft first.")

    const files = listDraftFiles(workspaceId).map(rel => path.join(ROOT_DIR, rel))
    for (const src of files) {
        const rel = path.relative(draftDir, src)
        const dest = path.join(ROOT_DIR, rel)
        ensureDir(dest)
        fs.copyFileSync(src, dest)
    }
    return {
        promoted: files.length,
        files: files.map(src => path.relative(ROOT_DIR, src).replace(/^draft\//, "")),
    }
}

function getWorkspaceSummary() {
    migrateLegacyProfile(DEFAULT_PROFILE)
    return {
        activeWorkspace: getActiveWorkspace(),
        workspaces: listWorkspaceIds().map(workspaceId => {
            const profile = loadProfile(workspaceId)
            return {
                workspaceId,
                businessName: profile.businessName || workspaceId,
                businessType: profile.businessType || "",
            }
        })
    }
}

module.exports = {
    DEFAULT_PROFILE,
    loadProfile,
    saveProfile,
    generateDraftFromProfile,
    listDraftFiles,
    promoteDraft,
    getWorkspaceSummary,
    setActiveWorkspace,
}
