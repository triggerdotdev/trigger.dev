---
"@trigger.dev/core": minor
"@trigger.dev/sdk": minor
"@trigger.dev/slack": minor
"trigger.dev": minor
---

Add hosted webhooks: receive and verify provider webhooks as a task, with no ingress or verification code of your own.

- `webhook()` declares an endpoint that routes a verified, typed event to an `onEvent` handler. Choose a source with a preset (`webhooks.stripe()`, `webhooks.github()`, and others) or `webhooks.custom<T>(config)`. Declared webhooks are discovered like tasks and synced to a hosted URL on deploy.
- `filter` gates which deliveries run, using a type-safe expression checked against the event at author time (`event.`/`header.`/`webhook.` paths, `&&`/`||`, comparison and `in`/`contains` operators, field-to-field comparison, and array quantifiers). A non-matching delivery is still recorded, not routed.
- `chat.event({ source, key, type })` routes deliveries that share a `key` to one durable session (per customer, installation, or issue) and delivers them to an agent's `onAction` as a typed envelope.
- Channels turn a chat surface into an agent frontend: `chat.channels.custom({ source, key, inbound, send })`, or the new `@trigger.dev/slack` package's `slack()` (Slack Events API verification, per-thread sessions, `chat.postMessage`/`chat.update` egress, `mentions()`, `startOn`, lifecycle reactions). Inbound messages run as turns and the reply posts back. Human-in-the-loop is built in: a tool with no `execute` pauses the turn, the connector posts controls (Slack ships Approve / Deny buttons), and a verified click resolves the tool and resumes the run.
- HTTP API for listing webhook endpoints and deliveries, plus rotate-secret, enable/disable, and replay.
