---
"@trigger.dev/sdk": patch
---

Added `query.execute()` which lets you query your Trigger.dev data using TRQL (Trigger Query Language) and returns results as typed JSON rows or CSV. It supports configurable scope (environment, project, or organization), time filtering via `period` or `from`/`to` ranges, and a `format` option for JSON or CSV output.

```typescript
import { query } from "@trigger.dev/sdk";
import type { QueryTable } from "@trigger.dev/sdk";

// Basic untyped query
const result = await query.execute("SELECT run_id, status FROM runs LIMIT 10");

// Type-safe query using QueryTable to pick specific columns
const typedResult = await query.execute<QueryTable<"runs", "run_id" | "status" | "triggered_at">>(
  "SELECT run_id, status, triggered_at FROM runs LIMIT 10"
);
typedResult.results.forEach(row => {
  console.log(row.run_id, row.status); // Fully typed
});

// Aggregation query with inline types
const stats = await query.execute<{ status: string; count: number }>(
  "SELECT status, COUNT(*) as count FROM runs GROUP BY status",
  { scope: "project", period: "30d" }
);

// CSV export
const csv = await query.execute(
  "SELECT run_id, status FROM runs",
  { format: "csv", period: "7d" }
);
console.log(csv.results); // Raw CSV string
```
