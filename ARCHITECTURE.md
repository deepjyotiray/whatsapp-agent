# Architecture

This document is for technical readers. It is short by design.

## Objective

The system provides a workspace-aware business assistant with:
- customer flow
- admin flow
- agent flow

The main design goal is to let LLMs help with reasoning and conversation while keeping routing, policy, and execution boundaries explicit.

## Core Runtime Flow

At a high level:

```text
Incoming message
  -> sanitize
  -> build workspace/customer context
  -> route intent
  -> apply policy
  -> choose backend or tool execution
  -> guard response
```

## UI Map For Technical Users

The main setup UI surfaces are:
- `Dashboard` for health, reload, and workspace summary
- `Business Profile` for workspace profile, draft generation, and promotion
- `Chat Sandbox` for live or draft customer testing
- `Agent Tools` for manifest, intents, tools, prompt guides, notes, and governance-related edits
- `Agent Configuration` for customer/admin/agent flow settings and runtime signals

Key UI ownership:
- `Business Profile` is the source of truth for business data entered by operators
- `Agent Configuration` is where flow mode and OpenClaw/backend settings are configured
- `Chat Sandbox` is the fastest runtime verification surface

## Main Parts

### Workspaces

Each business lives in its own workspace with its own:
- profile
- manifest
- policy
- notes and context

Key files and modules:
- [core/workspace.js](/Users/deepjyotiray/secure-agent/core/workspace.js)
- [setup/profileService.js](/Users/deepjyotiray/secure-agent/setup/profileService.js)

### Customer Flow

Customer turns are handled in:
- [runtime/customerFlow.js](/Users/deepjyotiray/secure-agent/runtime/customerFlow.js)
- [runtime/agentChain.js](/Users/deepjyotiray/secure-agent/runtime/agentChain.js)

Important stages:
- sanitizer
- conversation/customer state build
- intent routing
- pre-route and resolved policy checks
- backend or tool execution

### Routing

Intent routing lives in:
- [gateway/customerRouter.js](/Users/deepjyotiray/secure-agent/gateway/customerRouter.js)
- [gateway/intentParser.js](/Users/deepjyotiray/secure-agent/gateway/intentParser.js)

It uses:
- heuristics first
- LLM classification when needed
- manifest intents as the allowed target set

### Policy and Governance

Policy lives in:
- [runtime/customerPolicy.js](/Users/deepjyotiray/secure-agent/runtime/customerPolicy.js)
- [gateway/policyEngine.js](/Users/deepjyotiray/secure-agent/gateway/policyEngine.js)

Purpose:
- block unsafe or disallowed customer routes
- keep intent handling within allowed workspace rules
- preserve a governed path even when using backend conversation handling

### Backend Conversation Path

Backend conversation context is built in:
- [runtime/customerContext.js](/Users/deepjyotiray/secure-agent/runtime/customerContext.js)

When conversational backend mode is enabled, the backend receives:
- business profile facts
- conversation history
- conversation state
- DB context and schema when needed
- retrieval hints
- policy context for blocked conversational turns

This is what now allows more natural replies without hardcoding response logic in the runtime.

OpenClaw/backend service configuration is exposed through the UI and stored per flow. The runtime now supports flow-level backend configuration such as CLI command and timeout, which is read through:
- [providers/llm.js](/Users/deepjyotiray/secure-agent/providers/llm.js)
- [gateway/adminAgent.js](/Users/deepjyotiray/secure-agent/gateway/adminAgent.js)

### Deterministic Tool Path

Tool execution lives in:
- [runtime/executor.js](/Users/deepjyotiray/secure-agent/runtime/executor.js)

This path is used for structured tasks where deterministic behavior is preferred, such as:
- support flows
- order lookup
- ordering state transitions

## Configuration Contract

The customer path depends heavily on flow config:
- backend mode
- execution strategy
- backend capabilities
- response guard policy

See:
- [providers/llm.js](/Users/deepjyotiray/secure-agent/providers/llm.js)
- [runtime/flowOrchestrator.js](/Users/deepjyotiray/secure-agent/runtime/flowOrchestrator.js)
- [config/settings.example.json](/Users/deepjyotiray/secure-agent/config/settings.example.json)

## How To Test

Fastest technical test path:

1. Open `Dashboard`
   Confirm the agent is online and the expected workspace is active.
2. Open `Business Profile`
   Save business data, generate draft, and promote live.
3. Open `Agent Configuration`
   Verify customer flow backend mode, backend type, OpenClaw command, timeout, and backend capabilities.
4. Open `Chat Sandbox`
   Test in `Live Agent` mode.
5. Turn on `Pipeline Inspector`
   Check sanitizer, routing, policy, and final execution path.

Recommended test prompts:
- `hi`
- a core business intent like `what do you offer`
- a support request like `I need help`
- an off-domain prompt to see policy-guided behavior

Use `Draft` mode in `Chat Sandbox` when you want to validate changes before promotion.

## Mental Model

Keep this in mind:
- manifests define what the business can do
- policy defines what is allowed
- routing decides where a message should go
- backend handles flexible conversation
- tools handle structured business actions

## Related Docs

- Product overview: [README.md](/Users/deepjyotiray/secure-agent/README.md)
- Business setup: [ONBOARDING.md](/Users/deepjyotiray/secure-agent/ONBOARDING.md)
