---
"trigger.dev": patch
---

Added MCP tools for monitoring alerts: `list_alert_capabilities`, `list_alerts`, `create_alert`, and `resolve_alert`, so an MCP client can discover what a project can watch and manage alerts directly. Health capabilities expose customizable threshold params, discoverable via `list_alert_capabilities` and settable via `create_alert`.
