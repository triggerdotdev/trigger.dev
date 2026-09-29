---
"trigger.dev": patch
---

Added a `submit_feedback` MCP tool so coding agents can report a confusing tool error, a docs mismatch, or a missing capability without the user having to file it by hand. Turn it off with `--skip-telemetry` or `TRIGGER_TELEMETRY_DISABLED`; the tool is hidden while it is off.
