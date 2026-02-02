---
"@trigger.dev/cli-v3": patch
---

Fix: `trigger.dev dev` command left orphaned worker processes when exited via Ctrl+C (SIGINT). Added signal handlers to ensure proper cleanup of child processes and lockfiles. (#2909)
