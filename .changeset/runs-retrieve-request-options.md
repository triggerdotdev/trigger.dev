---
"@trigger.dev/sdk": patch
---

feat(runs): add clientConfig support to runs.retrieve() and runs.poll()

This change updates `runs.retrieve()` and `runs.poll()` to accept `TriggerApiRequestOptions` instead of `ApiRequestOptions`, enabling per-request client configuration via the `clientConfig` property.

This aligns `runs.retrieve()` with other SDK methods like `tasks.trigger()` that already support `clientConfig` for multi-project scenarios where different access tokens are needed per request.

Fixes #2769
