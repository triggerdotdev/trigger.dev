---
"@trigger.dev/core": patch
---

Retry `TASK_PROCESS_SIGSEGV` task crashes under the user's retry policy instead of failing the run on the first segfault. SIGSEGV in Node tasks is frequently non-deterministic (native addon races, JIT/GC interaction, near-OOM in native code, host issues), so retrying on a fresh process often succeeds. The retry is gated by the task's existing `retry` config + `maxAttempts` — same path `TASK_PROCESS_SIGTERM` and uncaught exceptions already use — so tasks without a retry policy still fail fast.
