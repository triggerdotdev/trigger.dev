---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Continuation chat boots no longer stall for around 10 seconds before the first turn. The `session.in` resume cursor is now found with a non-blocking records read instead of draining an SSE long-poll (which always waited out its full 5 second inactivity window, twice per boot), the boot reads run concurrently, and chat snapshots carry the cursor so subsequent boots skip the scan entirely.
