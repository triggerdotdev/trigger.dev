---
"@trigger.dev/core": patch
---

Fix: ConsoleInterceptor now delegates to original console methods to preserve log chain when other interceptors (like Sentry) are present. (#2900)
