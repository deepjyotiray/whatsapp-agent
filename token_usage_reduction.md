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