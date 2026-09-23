---
"@trigger.dev/sdk": minor
"@trigger.dev/core": minor
---

Concurrency limits can now be paused and resumed, just like queues: `concurrencyLimits.pause(name)` stops every run holding the limit from being dequeued while keeping its configured bounds, and `concurrencyLimits.resume(name)` starts them again.

```ts
import { concurrencyLimits } from "@trigger.dev/sdk";

await concurrencyLimits.pause("openai");
await concurrencyLimits.resume("openai");
```
