---
"@trigger.dev/core": patch
---

Self-hosted supervisors that run tasks in microVMs can now have a finished run's suspend snapshots deleted from shared storage, instead of leaving them behind. The server-only checkpoint client gains a `deleteSnapshots` call for this.
