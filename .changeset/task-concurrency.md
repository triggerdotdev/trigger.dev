---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Control a task's concurrency with the new `concurrency` option, and share limits across tasks with named concurrency limits. An inline shape caps the task itself; `concurrencyLimit()` declares a limit any task can hold (up to two named limits per task), and a trigger call can switch a run's named limits with its own `concurrency` option.

```ts
import { concurrencyLimit, task } from "@trigger.dev/sdk";

export const openaiLimit = concurrencyLimit({ name: "openai", total: 25 });

export const generateSummary = task({
  id: "generate-summary",
  concurrency: [{ perKey: 1, total: 5 }, openaiLimit],
  run: async (payload) => {},
});
```

`perKey` caps each `concurrencyKey` pool and `total` caps across everything, keys or not. The queue-level `concurrencyLimit` option keeps working unchanged and is deprecated in favor of `concurrency`. Enforcement happens server-side; servers without support accept the option but do not enforce it yet.
