---
"trigger.dev": patch
---

When you use Trigger.dev Cloud, the CLI and its MCP server now report usage analytics tied to your logged-in account: which commands run and which MCP tools are called, never the arguments you pass. Nothing is reported for self-hosted or local instances. Turn it off with `--skip-telemetry` or the `TRIGGER_TELEMETRY_DISABLED` environment variable.
