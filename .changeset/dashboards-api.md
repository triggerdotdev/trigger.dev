---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
"trigger.dev": patch
---

Manage custom metric dashboards from code. `query.dashboards` lists, creates, updates and deletes custom dashboards and their widgets, and every widget query is checked when it is saved. The MCP server adds `create_dashboard` and `set_dashboard_widgets`, so your AI assistant can build a dashboard for you.

```ts
import { query } from "@trigger.dev/sdk";

await query.dashboards.create({
  title: "Email tasks",
  widgets: [
    {
      title: "Total runs",
      query: "SELECT count() AS total FROM runs",
      display: { type: "bignumber", column: "total", aggregation: "sum" },
    },
  ],
});
```
