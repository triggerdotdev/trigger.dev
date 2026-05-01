---
"@trigger.dev/core": patch
---

Redact the `resolveWaitpoint` runtime log so it only emits `id` and `type` instead of the full completed waitpoint. Previously the log printed the entire waitpoint (including `output`) to stdout in production runs, which could leak sensitive payloads. The value returned by `wait.forToken()` is unchanged.
