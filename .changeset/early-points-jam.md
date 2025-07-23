---
"trigger.dev": patch
---

Gracefully shutdown task run processes using SIGTERM followed by SIGKILL after a 1s timeout. This also prevents cancelled or completed runs from leaving orphaned Ttask run processes behind
