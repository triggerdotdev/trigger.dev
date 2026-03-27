---
"trigger.dev": patch
---

Fix dev CLI leaking build directories on rebuild, causing disk space accumulation. Deprecated workers are now pruned (capped at 2 retained) when no active runs reference them. The watchdog process also cleans up `.trigger/tmp/` when the dev CLI is killed ungracefully (e.g. SIGKILL from pnpm).
