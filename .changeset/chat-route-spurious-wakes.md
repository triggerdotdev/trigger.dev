---
"@trigger.dev/sdk": patch
---

Chat agents now return to a durable wait when a session wake does not deliver a matching message. This prevents resumed runs from staying active until their maximum duration and preserves the configured turn timeout across repeated wakes.
