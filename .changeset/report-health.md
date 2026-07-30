---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Ask whether an environment is healthy and get an answer instead of a wall of charts. `trigger report health` returns a verdict on three questions: is work flowing, are the runs that start succeeding, and is the telemetry fresh enough to trust either answer. When something looks wrong it names the most likely cause and a next action.

```bash
npx trigger.dev@latest report health --env prod --period 24h
```

The verdict is computed server side, so the CLI, the new `get_report` MCP tool, and `GET /api/v1/reports/health` all return the same text with the same sparklines. In MCP hosts that support prompts, `report` is also available as a slash command.
