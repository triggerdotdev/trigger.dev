---
"@trigger.dev/sdk": patch
---

Fixed `AgentChat` silently ignoring `maxDuration`, `region` and `lockToVersion` when they were set on its `triggerConfig`. They are now applied to the session's runs.
