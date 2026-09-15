---
"@trigger.dev/schema-to-json": patch
---

Fix Zod 4 schema conversion throwing "Date cannot be represented in JSON Schema". `z.date()` fields now convert to `{ type: "string", format: "date-time" }` instead of aborting the whole conversion, which was causing the MCP server's `tools/list` to fail (no tools loaded) whenever a tool schema contained a date.
