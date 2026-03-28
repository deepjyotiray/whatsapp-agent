# Onboarding

This guide is for a business owner or operator. It is intentionally short.

## What You Are Setting Up

You are creating a business workspace with:
- your business profile
- your assistant rules
- your business policy

Once set up, the assistant can answer customer questions and route business-related requests properly.

## What You Need

Before you start, keep these ready:
- business name
- business type
- phone number
- website or menu link, if you have one
- support contact details
- OpenAI key or backend setup, if your install requires it

## If You Are Using OpenClaw

Make sure OpenClaw is installed and available on the machine running this app.

In the UI, OpenClaw is configured from:
- `Agent Configuration`

What you set there:
- flow mode: `Backend Service`
- backend type: `OpenClaw`
- CLI command: usually `openclaw`
- timeout: how long the runtime should wait for the backend

If the OpenClaw binary is not on the default path, enter the full command or path in the `CLI Command` field.

## Setup Flow

Follow this order:

1. Create or open your workspace.
2. Fill in the business profile.
3. Generate the workspace draft.
4. Review the generated business details.
5. Promote the draft so it becomes live.
6. Switch to that workspace.
7. Test a few customer messages.

## Using The UI

If the app is running, open the setup UI in your browser.

Use the pages in this order:

1. `Dashboard`
   Check that the agent is online and note the active workspace.
2. `Business Profile`
   Enter business details, then click `Save Profile`.
3. `Business Profile`
   Click `Generate Draft`.
4. `Business Profile`
   Review the detected intents, FAQ topics, and draft files.
5. `Business Profile`
   Click `Promote Live`.
6. `Chat Sandbox`
   Ask sample customer questions and check the replies.

If needed:
- `Agent Configuration` is where flow settings and OpenClaw/backend settings are adjusted
- `Agent Tools` is where a technical person can edit manifests, intents, tools, and notes

## Where To Add Business Data

Use `Business Profile`.

This is where you enter:
- business name and type
- brand voice and description
- website, phone, email, address, and business hours
- offerings, pricing notes, FAQ seed topics, refund policy, and support rules
- DB path, knowledge URLs, and admin details

After saving, click `Generate Draft` so the system can create the workspace draft from this data.

## What To Review Before Going Live

Check these items:
- business name is correct
- support phone and email are correct
- menu or offerings look right
- refund or support policy is correct
- domain keywords roughly match what customers will ask

## Simple Test Messages

Try these:
- `hi`
- `what do you sell`
- `how do I place an order`
- `I need help`
- one business-specific question a real customer would ask

## How To Test In The UI

Go to `Chat Sandbox`.

Use:
- `Live Agent` if you want to test what is currently live
- `Draft` if you want to test changes before promotion
- `Pipeline Inspector` if a technical person wants to inspect routing and policy

Good first checks:
- greeting works
- a core business question works
- a support question works
- the reply sounds like the business
- the assistant stays inside the business topic

## Where To Configure The Backend

Go to `Agent Configuration`.

For the `Customer Flow`:
1. set mode to `Backend Service` if you want OpenClaw or another backend to handle conversational requests
2. choose backend type
3. set the OpenClaw CLI command if needed
4. set timeout
5. save the flow settings

Do the same for `Admin Flow` or `Agent Flow` if those should also use a backend service.

## If Something Feels Wrong

Most issues come from one of these:
- workspace was created but not promoted
- wrong workspace is active
- business profile is incomplete
- policy is too strict or missing domain keywords
- backend/LLM mode is not configured

## Where To Go Next

- For product and purpose, read [README.md](/Users/deepjyotiray/secure-agent/README.md).
- For technical details, read [ARCHITECTURE.md](/Users/deepjyotiray/secure-agent/ARCHITECTURE.md).
