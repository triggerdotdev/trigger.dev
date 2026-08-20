---
"@trigger.dev/sdk": patch
---

Injected system context is merged into a single instruction block, so it works on every supported AI SDK version. Note that a cached system prompt gives up its cache entry for as long as an injection is live, since the cached prefix has changed.
