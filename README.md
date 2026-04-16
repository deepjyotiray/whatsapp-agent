# secure-agent

`secure-agent` is a self-hosted AI runtime for small businesses that want a practical customer assistant and an internal operator assistant on top of their own data.

It is built to let a business run:
- a customer-facing assistant for WhatsApp, HTTP, or CLI
- a protected admin/agent workflow for ops and internal tasks
- grounded answers using business data, policy, and workspace context

## What It Does Today

Right now the system supports:
- customer conversations for menu, ordering, support, and general business chat
- workspace-based business profiles, manifests, and policy
- backend/LLM-assisted conversational handling with governance and response guards
- backend targets including OpenClaw-style local CLIs and OpenAI-compatible HTTP services such as G0DM0D3
- deterministic tool flows for structured tasks like support, order lookup, and ordering
- admin and agent paths with separate controls and governance
- multiple transports: WhatsApp, HTTP, and CLI

## Why It Is Useful

Benefits for a business:
- keeps business context inside your own workspace
- reduces hardcoded chatbot behavior
- separates customer support from admin operations
- allows safer LLM usage through policy, routing, and guarded execution
- supports multiple businesses through workspaces

Benefits for a technical team:
- manifest-driven behavior
- workspace-aware policy and context
- backend-first conversational path when configured
- deterministic execution for high-confidence structured actions
- clear runtime separation between customer, admin, and agent flows

## Where To Start

- If you are setting up a business, read [ONBOARDING.md](/Users/deepjyotiray/secure-agent/ONBOARDING.md).
- If you are working on the system, read [ARCHITECTURE.md](/Users/deepjyotiray/secure-agent/ARCHITECTURE.md).

## Using The UI

The setup UI is the fastest way to use the system.

Main pages:
- `Dashboard` for health, workspace, reload, and quick links
- `Business Profile` for workspace creation, profile editing, draft generation, and promotion
- `Chat Sandbox` for customer-side testing
- `Agent Tools` for manifest, intents, tools, notes, and governance-related edits
- `Agent Configuration` for customer/admin/agent flow settings

Recommended path:
1. Open the UI.
2. Create or switch to a workspace.
3. Fill the business profile.
4. Generate draft.
5. Promote live.
6. Open Chat Sandbox and test customer questions.

Business data is added from `Business Profile`.
Backend service settings such as OpenClaw are configured from `Agent Configuration`.

### Custom Chat Access

If you want a branded entry page for a host like `agent.healthymealspot.com`, configure the `setup` block in [config/settings.json](/Users/deepjyotiray/secure-agent/config/settings.json):
- `hosts` sets which hostnames are treated as setup/chat UI hosts
- `username` and `password` define the setup login credentials
- `brand`, `login_title`, `login_lede`, and `login_submit` control the custom login UI

The setup UI always requires username/password auth and issues a signed session cookie after successful login.

## G0DM0D3 Backend

`secure-agent` can now use [G0DM0D3](https://github.com/elder-plinius/G0DM0D3) as a conversational backend through its OpenAI-compatible API.

Recommended setup:
- run the G0DM0D3 API server separately, usually on `http://127.0.0.1:7860`
- in `Agent Configuration`, switch the customer flow to `Backend Service`
- choose backend type `G0DM0D3`
- set `Backend Endpoint` to your server URL
- set `LLM Model` to a G0DM0D3 model such as `ultraplinian/fast`, `consortium/fast`, or any single OpenRouter model exposed by G0DM0D3
- set `API Key / Secret` only if your G0DM0D3 server requires bearer auth
- set `OpenRouter API Key` in backend config only if the G0DM0D3 server does not already have `OPENROUTER_API_KEY`
- optional advanced backend settings in the setup UI cover GODMODE, custom system prompt, AutoTune, sampling overrides, Parseltongue, STM modules, Liquid tuning, consortium orchestrator override, and dataset contribution
- streaming is also supported for G0DM0D3 backend calls when you enable it in the setup UI

How it behaves here:
- `secure-agent` still keeps structured business actions on tools when your customer execution strategy says so
- G0DM0D3 handles the conversational backend turns
- the existing customer response guard still validates the backend output before it is sent to the user
- all customer backend paths can now also use `execution.backend_tuning` and `execution.response_transforms` for lightweight intent-aware sampling and STM-style cleanup, including `openclaw` and direct LLM providers
- supported non-OpenClaw backend paths can also use `execution.backend_ensemble` for multi-model `race` or `consensus` orchestration when you want richer conversational quality on hard turns
- retrieval now uses lightweight query normalization and TTL caches on the SQL and LanceDB RAG paths to reduce repeated work on common lookups

## Quick Test

For business users:
- use the UI path in [ONBOARDING.md](/Users/deepjyotiray/secure-agent/ONBOARDING.md)

For technical users:
- verify runtime behavior in [ARCHITECTURE.md](/Users/deepjyotiray/secure-agent/ARCHITECTURE.md)
- then test via `Chat Sandbox`, `Dashboard`, and `Agent Configuration`

## Quick Mental Model

There are three main layers:
- onboarding and workspace setup
- customer/admin runtime behavior
- governance around what the assistant is allowed to do

For technical details, go to [ARCHITECTURE.md](/Users/deepjyotiray/secure-agent/ARCHITECTURE.md).
For business setup, go to [ONBOARDING.md](/Users/deepjyotiray/secure-agent/ONBOARDING.md).
