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
