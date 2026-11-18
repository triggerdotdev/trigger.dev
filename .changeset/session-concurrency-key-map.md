---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Sessions and `chat.agent` now accept the object form of `concurrencyKey` in `triggerConfig`, giving each concurrency limit its own key, the same as `task.trigger()`.
