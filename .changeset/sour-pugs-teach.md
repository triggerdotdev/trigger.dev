---
"trigger.dev": patch
"@trigger.dev/core": patch
---

v3: fix otel flushing causing CLEANUP ack timeout errors by always setting a forceFlushTimeoutMillis value
