---
"@trigger.dev/schema-to-json": patch
---

Fixed MCP `tools/list` failing with "Date cannot be represented in JSON Schema" when a tool used `z.date()`. Date fields now show up as date-time strings instead of breaking the whole tool list.
