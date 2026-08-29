---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Adjust queue concurrency at runtime, per key and combined. `queues.overrideConcurrencyLimit` accepts a `concurrencyKey` to raise or lower one key's limit without touching the rest of the queue, and the new `queues.overrideCombinedConcurrencyLimit` and `queues.resetCombinedConcurrencyLimit` adjust the cap across all keys.

```ts
import { queues } from "@trigger.dev/sdk";

await queues.overrideConcurrencyLimit("my-queue", 20, { concurrencyKey: "tenant-123" });
await queues.resetConcurrencyLimit("my-queue", { concurrencyKey: "tenant-123" });

await queues.overrideCombinedConcurrencyLimit("my-queue", 100);
await queues.resetCombinedConcurrencyLimit("my-queue");
```

Overrides survive deploys and reset back to the declared configuration. Enforcement happens server-side on servers with combined concurrency limits enabled.
