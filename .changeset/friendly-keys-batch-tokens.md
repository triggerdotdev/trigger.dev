---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Allow task-scoped environment API keys to run batch operations for their permitted tasks. The SDK declares the batch's task set before creation, and `@trigger.dev/core/v3/apiKeys` now exports the additional-key format helper.
