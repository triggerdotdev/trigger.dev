---
"@trigger.dev/core": patch
---

Truncate large error stacks and messages to prevent OOM crashes. Stack traces are capped at 50 frames (keeping top 5 + bottom 45 with an omission notice), individual stack lines at 1024 chars, and error messages at 1000 chars. Applied in parseError, sanitizeError, and OTel span recording.
