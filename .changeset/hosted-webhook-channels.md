---
"@trigger.dev/sdk": minor
"@trigger.dev/slack": minor
"trigger.dev": minor
---

Route hosted webhooks into agents, and turn chat surfaces into agent frontends.

- `chat.event({ source, key, type })` routes deliveries that share a `key` to one durable session (per customer, installation, or issue) and delivers them to an agent's `onAction` as a typed envelope.
- Channels turn a chat surface into an agent frontend: `chat.channels.custom({ source, key, inbound, send })`, or the new `@trigger.dev/slack` package's `slack()` (Slack Events API verification, per-thread sessions, `chat.postMessage`/`chat.update` egress, `mentions()`, `startOn`, lifecycle reactions). Inbound messages run as turns and the reply posts back.
- Human-in-the-loop is built in: a tool with no `execute` pauses the turn, the connector posts controls (Slack ships Approve / Deny buttons), and a verified click resolves the tool and resumes the run.
- `chat.createWatchToken(externalId)` mints a read-only token to watch a session from another surface.
- The CLI warns about a `chat.event` no agent lists.
