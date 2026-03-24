### Token Usage Reduction Strategies

To reduce token usage and improve efficiency, the system implements several multi-layered strategies across its architecture. Here’s a breakdown of how we achieve significant token savings:

#### 1. Deterministic Intent Routing (Heuristics)
Instead of calling the LLM for every message, the `gateway/customerRouter.js` uses **keyword-based heuristics** to identify common intents like greetings ("hi", "hello") or support requests ("help", "issue").
- **Benefit**: Skips the expensive LLM classification step for simple, high-frequency user inputs.
- **Implementation**: If a strong heuristic match is found, the system routes the message directly to the appropriate tool.

#### 2. Intent Caching
The `runtime/previewEngine.js` implements a short-term **Intent Cache** (30-second TTL). 
- **Benefit**: If the system needs to process the same message multiple times (e.g., once for generating a "Preview" in the admin dashboard and again for "Executing" the response), it reuses the first LLM result instead of calling the provider again.

#### 3. Smart Retrieval (RAG) Filtering
Both `rag.js` and `tools/genericRagTool.js` perform heavy lifting before the LLM is even involved.
- **Keyword Pre-filtering**: Uses LanceDB or SQLite to search for the most relevant data first.
- **Result Capping**: Only the top 3–5 most relevant documents are passed into the prompt.
- **Character Truncation**: RAG data is strictly capped at **4,000 characters** (approx. 1,000 tokens) to prevent "context window bloat" and keep input costs predictable.

#### 4. Deterministic Explanation Building
In the `runtime/previewEngine.js`, the "Reasoning" or "Explanation" for why a specific tool was chosen is built using **deterministic logic** rather than asking the LLM to explain itself.
- **Benefit**: We generate a rich, human-readable explanation of the agent's logic (intent, tool used, risk level) with zero additional token cost.

#### 5. Session-Based Short-circuiting
When a user is in an active "Support Handoff" or "Active Cart" session, `runtime/agentChain.js` skips the Intent Router entirely.
- **Benefit**: Subsequent messages are automatically routed to the active tool, saving an LLM call for every turn in a continuous conversation.

#### 6. History Management
The `runtime/sessionMemory.js` maintains a rolling window of conversation history.
- **Capped Turns**: It only stores the last **10 exchanges** (20 turns total).
- **Benefit**: This prevents the context window from growing indefinitely, ensuring that long-running conversations don't become exponentially more expensive over time.

#### 7. Fast-Path Short-circuiting in Responses
In `gateway/responder.js`, if the RAG search returns "no results found," the system returns that message directly to the user.
- **Benefit**: It avoids calling the LLM to generate a "sorry, I don't know" response when the underlying data is clearly missing.

#### 8. Provider-Level Constraints
The LLM providers (like `providers/mlx.js`) are configured with a default `max_tokens` (typically 1,000) to ensure the model doesn't generate unnecessarily long or repetitive outputs, protecting against "runaway" generation costs.

#### 9. OpenClaw Context Pruning (Schema Selector)
For complex administrative tasks sent to OpenClaw, the system uses a first-pass LLM call to identify only the relevant database tables for the given task.
- **Benefit**: Instead of sending the entire database schema and sample data for all tables (which can be thousands of tokens), it only sends the subset necessary to solve the problem.
- **Implementation**: `gateway/adminAgent.js` calls `selectRelevantTables` before building the OpenClaw prompt.

#### 10. OpenClaw Workspace Optimization
The OpenClaw workspace instructions (`AGENTS.md` and `SOUL.md`) have been pruned to remove boilerplate and verbose guidelines.
- **Benefit**: Reductions in the initial "identity" loading for every OpenClaw session. `AGENTS.md` was reduced from ~7.7KB to <1KB, and `SOUL.md` was reduced by ~50%.
- **Implementation**: Replaced verbose sections in the specialized workspace files (`~/.openclaw/admin_workspace/` and `~/.openclaw/agent_workspace/`) with concise, bulleted summaries.

#### 11. Tool Metadata Injection, Filtering & Multi-Agent Isolation
When calling the OpenClaw CLI, the system uses separate isolated agents ('admin' and 'agent') and injects a structured description of only the *allowed* tools (`query_db`, `run_shell`, etc.) directly into the agent's specific workspace. The legacy 'main' agent has been removed to ensure specialized contexts and prevent tool leakage.
- **Benefit**: Ensures that the agent is aware of its specific capabilities, prevents it from trying to use disallowed tools, and isolates the history/context between standard admin commands and autonomous agent flows.
- **Implementation**: `gateway/adminAgent.js` filters `CORE_TOOL_DEFINITIONS` based on the flow type (`admin.tools` vs `admin.agent_tools`), updates the appropriate workspace's `TOOLS.md` (`~/.openclaw/admin_workspace/` or `~/.openclaw/agent_workspace/`), and runs OpenClaw with the corresponding `--agent` flag. Legacy workspaces and agent configurations for 'main' were deleted.

#### 12. Native Skill Mapping for Agentic Backends
Custom "Skills" are registered within the OpenClaw backend to bridge it with the system's local database and shell.
- **Benefit**: This provides a direct, low-latency execution path for administrative tasks without relying on external APIs or complex wrappers.
- **Implementation**: Skills like `query_db` and `run_shell` are registered in OpenClaw's skill directory and point to local shell scripts (`query.sh`, `shell.sh`) that execute database queries and allowlisted commands.

#### 13. Data Model Notes Injection
The system injects a `data-model-notes.md` file into the agent's context during the prompt construction.
- **Benefit**: To improve SQL accuracy and reduce counting errors. This file provides critical business logic (e.g., "one customer can have multiple subscriptions") and schema nuances that prevent miscounts and logical errors during data retrieval.
- **Implementation**: `gateway/adminAgent.js` reads `data/workspaces/{workspaceId}/config/data-model-notes.md` and injects it into the OpenClaw task prompt.

---

### Advanced Strategies (Recommendations)

To further reduce token usage, the following strategies could be implemented:

#### 1. Dynamic History Summarization
Instead of just a rolling window (last 10 turns), we can implement **History Summarization** in `runtime/sessionMemory.js`.
- **Approach**: After 10 turns, instead of dropping older messages, we can call a lightweight "summarizer" LLM to condense those turns into a 1-2 sentence summary and append it to the context.
- **Benefit**: Maintains long-term context while keeping the input prompt length fixed.

#### 2. Intent-Specific Context Injection
In `runtime/executor.js`, the `buildProfileFacts` function currently sends all business profile data to every tool call.
- **Optimization**: Only inject facts that are relevant to the selected tool (e.g., don't send "opening hours" to a "check stock" tool).
- **Benefit**: Reduces prompt noise and input tokens by 20–30% for small-to-medium businesses.

#### 3. Token-Aware RAG Truncation
Current RAG truncation in `gateway/responder.js` uses a static **4,000-character** limit.
- **Optimization**: Use a token-counting library (like `tiktoken`) to truncate precisely at a target token count (e.g., 800 tokens).
- **Benefit**: Prevents "over-truncating" dense text and "under-truncating" sparse text, leading to more consistent costs.

#### 4. Negative Result Caching
If a keyword search in `rag.js` or `tools/genericRagTool.js` returns "no results," we can cache that specific query as "empty" for a short TTL (e.g., 10 minutes).
- **Benefit**: If a user repeats a query that previously failed, we skip both the database search and the subsequent LLM "fallback" call.

#### 5. Planner Step Pruning
The `runtime/plannerEngine.js` currently sends the **entire list of available intents and tools** to the LLM to build a plan.
- **Optimization**: Use a first-pass keyword matcher to narrow down the "candidate tools" before asking the Planner to build the sequential plan.
- **Benefit**: Significantly reduces the input prompt size for agents with 20+ tools.
### Strategy #12: Native Skill Mapping, Identity Alignment & Reinforced Prompting
To ensure administrative agents (like OpenClaw) use tools reliably:
- **Native Skill Bridge**: Map internal tools (`query_db`, `run_shell`) to OpenClaw's native "Skills" directory. This makes them appear as "first-class" capabilities to the agent.
- **Identity & Authorization**: Update workspace files (`IDENTITY.md`, `AGENTS.md`, `USER.md`) to establish the agent's identity as an "Authorized Admin" and document explicit user authorization. This prevents the model's safety/refusal heuristics from blocking tool usage.
- **Dynamic Skill Sync**: The agent's workspace `TOOLS.md` is updated in real-time with available tools before each task.
- **Reinforced Prompting**: Task prompts include explicit "AVAILABLE TOOLS" blocks and "SYSTEM INSTRUCTIONS" that command immediate tool usage and provide concrete invocation examples, including fallback syntaxes like `skill_call(skill="...", args={...})`.
- **Anticipatory Error Handling**: Instructions explicitly forbid "lack of access" or "permission required" responses if tools are present in the allowlist.
- **Clean Slate Synchronization**: When a tool is added or removed from the allowlist in the management console, the system automatically clears all existing OpenClaw sessions for the specialized agents (`admin` and `agent`). This prevents "context poisoning" where the agent's memory contains past failures or outdated tool definitions, ensuring a fresh, accurate state for every configuration change.
