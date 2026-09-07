---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
"@trigger.dev/react-hooks": patch
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

Manage limits at runtime with the new `concurrencyLimits` namespace: `list()` and `retrieve(name)` report each limit's bounds plus its live `running` and `queued` counts, `override(name, { perKey, total })` changes only the given bounds (overriding `total` to `0` pauses the limit), and `reset(name)` restores the declared values.

Queue reads (`queues.list()` and `queues.retrieve()`) now report a `version` that discriminates the shape: `V1` queues keep today's fields (their own `concurrencyLimit` and its override state), while `V2` queues (tasks declared with `concurrency`) carry no queue-level concurrency, since their limits are read and overridden through `concurrencyLimits` (a task's inline limit under its derived `task/<task-id>` name). Existing reads keep compiling: a `V2` queue reports `concurrencyLimit` as null and `concurrency` as undefined.
