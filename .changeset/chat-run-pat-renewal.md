---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Add run-scoped PAT renewal for chat transport (`renewRunAccessToken`), fail fast on 401/403 for SSE without retry backoff, and export `isTriggerRealtimeAuthError` for auth-error detection.
