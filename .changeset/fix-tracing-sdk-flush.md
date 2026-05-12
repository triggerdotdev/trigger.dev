---
"@trigger.dev/core": patch
---

Fixed TracingSDK.flush() and shutdown() to use Promise.allSettled instead of Promise.all, preventing one provider's rejection from abandoning the other providers' in-flight exports. This fixes an issue where user-emitted trace data (logger.info calls, child spans) could be silently dropped on shutdown when any provider fails to flush.
