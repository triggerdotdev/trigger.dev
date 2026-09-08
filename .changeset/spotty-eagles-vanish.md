---
"trigger.dev": patch
---

Fixes intermittent deploy failures when BuildKit is slow to become ready — the build is now retried once after restarting BuildKit — and keeps registry login output out of build failure logs.
