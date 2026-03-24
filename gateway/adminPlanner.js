"use strict"

const { complete } = require("../providers/llm")
const { listWorkers } = require("./adminWorkers")
const { registerGuide } = require("../core/promptGuides")

function safeJson(text) {
    if (!text) return null
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return null
    try { return JSON.parse(match[0]) } catch { return null }
}

function fallbackPlan(task) {
    return {
        summary: "Inspect the request, gather evidence with tools, complete the task, and report the result.",
        steps: [
            { id: "understand", worker: "researcher", goal: `Understand the task: ${task}`, preferred_tools: ["list_tools", "read_file", "query_db", "http_request"] },
            { id: "execute", worker: "operator", goal: "Use the right tools to complete the task safely.", preferred_tools: ["run_shell", "query_db", "open_browser", "http_request", "run_skill"] },
            { id: "verify", worker: "researcher", goal: "Verify the result before responding.", preferred_tools: ["read_file", "query_db", "server_health", "get_current_url"] },
        ],
    }
}

async function buildAdminPlan(task, context = {}) {
    const { prepareRequest } = require("../runtime/contextPipeline")
    const flow = context.flow || "admin"
    const workers = listWorkers().map(worker =>
        `- ${worker.name}: ${worker.description}. Strengths: ${worker.strengths.join(", ")}`
    ).join("\n")
    
    const systemContext = `You are the planner for a secure admin operations agent.
Return JSON only.
Business context: ${context.businessName || "Business not specified"}
Available workers:
${workers}`

    const prompt = `Create a short execution plan for this admin task. Keep it practical, tool-oriented, and safe.
Use 2 to 5 steps max.

Available tool families:
- shell and process control
- database reads and updates
- http requests and recon
- browser automation
- file read/write and node execution
- whatsapp sending
- skills

Task:
${task}

Return exactly:
{
  "summary": "one sentence",
  "steps": [
    {
      "id": "short-id",
      "worker": "planner|researcher|operator|coder",
      "goal": "what to accomplish",
      "preferred_tools": ["tool_a", "tool_b"]
    }
  ]
}`

    try {
        const messages = prepareRequest(prompt, flow, { systemContext })
        const text = await complete(messages, { flow })
        const parsed = safeJson(text)
        if (!parsed || !Array.isArray(parsed.steps) || !parsed.steps.length) return fallbackPlan(task)
        return {
            summary: parsed.summary || fallbackPlan(task).summary,
            steps: parsed.steps.slice(0, 5).map((step, idx) => ({
                id: step.id || `step-${idx + 1}`,
                worker: ["planner", "researcher", "operator", "coder"].includes(step.worker) ? step.worker : "operator",
                goal: step.goal || "Complete the next part of the task.",
                preferred_tools: Array.isArray(step.preferred_tools) ? step.preferred_tools : [],
            })),
        }
    } catch {
        return fallbackPlan(task)
    }
}

registerGuide({
    id: "admin-planner",
    name: "Admin planner",
    description: "Prompt sent to the LLM to generate an execution plan before the agent loop starts.",
    source: "gateway/adminPlanner.js",
    editable: "Workers via gateway/adminWorkers.js",
    render() {
        const workers = listWorkers().map(w => `- ${w.name}: ${w.description}. Strengths: ${w.strengths.join(", ")}`).join("\n")
        return `You are the planner for a secure admin operations agent.\nReturn JSON only.\n\nAvailable workers:\n${workers}\n\nTask: (user's task at runtime)`
    },
})

module.exports = { buildAdminPlan }
