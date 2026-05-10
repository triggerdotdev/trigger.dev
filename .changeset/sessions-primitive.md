---
"@trigger.dev/sdk": minor
"@trigger.dev/core": patch
---

Adds the Sessions primitive — a durable, run-aware stream channel keyed
on a stable `externalId`. Public SDK additions: `tasks.triggerAndSubscribe()`
and the `chat.agent` runtime built on top of Sessions. See
https://trigger.dev/docs/ai-chat/overview for the full feature surface.
