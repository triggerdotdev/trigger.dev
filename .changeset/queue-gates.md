---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Hold a run's concurrency slot in more than one queue with queue gates. Pass an array as `queue`: the first entry is the queue the run waits in, and up to two more name gates, other queues the run must also have capacity in and occupies while it executes. A gate without a `concurrencyKey` uses the run's own key, so a shared `tenant` queue caps a tenant across every task; a literal key pins the gate to one slot pool, capping, say, all traffic to one external provider.

```ts
import { queue, task } from "@trigger.dev/sdk";

export const tenant = queue({ name: "tenant", concurrencyLimit: 10 });

export const processWebhook = task({
  id: "process-webhook",
  queue: [{ name: "webhooks", concurrencyLimit: 2 }, "tenant"],
  run: async (payload) => {},
});

await processWebhook.trigger(payload, { concurrencyKey: tenantId });
```

The same array form works on `queue` when triggering, replacing the task's gates for that run. Enforcement happens server-side; servers without queue gates enabled accept the option but run without it.
