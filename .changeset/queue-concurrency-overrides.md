---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Adjust a queue's combined concurrency limit at runtime. `queues.overrideCombinedConcurrencyLimit` raises or lowers the cap on concurrent runs across all of a queue's `concurrencyKey` values, and `queues.resetCombinedConcurrencyLimit` reverts to the declared configuration.

```ts
import { queues } from "@trigger.dev/sdk";

await queues.overrideCombinedConcurrencyLimit("my-queue", 100);
await queues.resetCombinedConcurrencyLimit("my-queue");
```

Overrides survive deploys. Enforcement happens server-side on servers with combined concurrency limits enabled.
