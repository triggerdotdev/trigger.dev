---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Adjust queue concurrency at runtime, per key and in total. `queues.overrideConcurrencyLimit` accepts a `concurrencyKey` to raise or lower one key's limit without touching the rest of the queue, and the new `queues.overrideTotalConcurrencyLimit` and `queues.resetTotalConcurrencyLimit` adjust the cap across all keys.

```ts
import { queues } from "@trigger.dev/sdk";

await queues.overrideConcurrencyLimit("my-queue", 20, { concurrencyKey: "tenant-123" });
await queues.resetConcurrencyLimit("my-queue", { concurrencyKey: "tenant-123" });

await queues.overrideTotalConcurrencyLimit("my-queue", 100);
await queues.resetTotalConcurrencyLimit("my-queue");
```

Overrides survive deploys and reset back to the declared configuration. Enforcement happens server-side on servers with total concurrency limits enabled.
