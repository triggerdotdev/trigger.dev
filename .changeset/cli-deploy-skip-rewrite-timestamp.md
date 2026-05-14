---
"trigger.dev": patch
---

Add `TRIGGER_BUILD_SKIP_REWRITE_TIMESTAMP=1` escape hatch for local self-hosted builds whose buildx driver doesn't support `rewrite-timestamp` alongside push (e.g. orbstack's default `docker` driver).
