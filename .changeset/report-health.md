---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Add the `get_report` MCP tool, a `trigger report` CLI command, and `GET /api/v1/reports/:key`, starting with the `health` report: a deterministic verdict on whether work is flowing, whether the runs that start are healthy, and whether telemetry is fresh — rendered as text with unicode sparklines (coloured in a terminal). Also adds a `report` MCP prompt, surfaced as a slash command in hosts that support prompts.

Also: `trigger mcp` now always starts the server — the install wizard is gated behind `trigger mcp --install`. A TTY previously launched the wizard, so MCP hosts spawning the server over a PTY timed out.
