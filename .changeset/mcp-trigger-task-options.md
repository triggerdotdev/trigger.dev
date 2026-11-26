---
"trigger.dev": patch
---

The MCP server's `trigger_task` tool now accepts `metadata`, `idempotencyKeyTTL`, `concurrencyKey`, `concurrency`, `debounce`, `lockToVersion` and `priority`, matching the options you can pass when triggering from the SDK or the dashboard. Calls without them behave as before.

`trigger_task` no longer sets a 10 minute ttl on its own when you pass any option, including existing ones such as `tags`. A run now gets the ttl you pass, otherwise the task's ttl, otherwise 10 minutes in dev and the server's maximum ttl elsewhere (14 days on Trigger.dev Cloud; no expiry on a self-hosted server without one), and a ttl longer than the server's maximum is capped at it. Pass `ttl: "10m"` to keep the old behaviour.
