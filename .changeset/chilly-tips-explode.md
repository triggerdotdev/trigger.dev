---
"trigger.dev": patch
---

Add platform notifications support to the CLI. The `trigger dev` and `trigger login` commands now fetch and display platform notifications (info, warn, error, success) from the server. Includes discovery-based filtering to conditionally show notifications based on project file patterns, color markup rendering for styled terminal output, and a non-blocking display flow with a spinner fallback for slow fetches. Use `--skip-platform-notifications` flag with `trigger dev` to disable the notification check.
