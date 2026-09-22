---
"@trigger.dev/schema-to-json": patch
---

Convert Zod 4 `z.date()` fields to date-time strings in JSON Schema without weakening validation for other unsupported types. This prevents MCP tool discovery from failing when a tool input schema contains a date.
