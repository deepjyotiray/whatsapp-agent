"use strict"

const INJECTION_PATTERNS = [
    /ignore\s+(previous|above|system|all)\s+(instructions?|prompts?|rules?)/i,
    /system\s*(prompt|instructions?)/i,
    /you\s+are\s+now/i,
    /act\s+as\s+(a\s+)?(different|new|another|unrestricted)/i,
    /jailbreak/i,
    /execute\s+(command|code|script|shell)/i,
    /read\s+\/?(\.env|etc\/passwd|etc\/shadow|proc\/)/i,
    /\$\(.*\)/,           // command substitution
    /`[^`]*`/,            // backtick execution
    /<script[\s>]/i,      // script injection
    /\beval\s*\(/i,
    /\bexec\s*\(/i,
    /require\s*\(\s*['"]fs['"]/i,
    /process\.env/i,
    /\.\.\//,             // path traversal
]

const MAX_LENGTH = 500

/**
 * @param {string} input
 * @returns {{ safe: boolean, reason?: string }}
 */
function sanitize(input) {
    if (typeof input !== "string" || input.trim().length === 0) {
        return { safe: false, reason: "empty_input" }
    }

    if (input.length > MAX_LENGTH) {
        return { safe: false, reason: "input_too_long" }
    }

    for (const pattern of INJECTION_PATTERNS) {
        if (pattern.test(input)) {
            return { safe: false, reason: "injection_detected" }
        }
    }

    return { safe: true }
}

module.exports = { sanitize }
