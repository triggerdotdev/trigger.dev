---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Cap a queue's total concurrency across all of its `concurrencyKey` values with the new `totalConcurrencyLimit` queue option. On a keyed queue, `concurrencyLimit` applies to each key value independently, so ten active keys with a limit of 5 can run 50 at once. `totalConcurrencyLimit` bounds the whole queue while each key still gets at most `concurrencyLimit`.

```ts
import { queue } from "@trigger.dev/sdk";

export const perUserQueue = queue({
  name: "per-user-queue",
  concurrencyLimit: 1,
  totalConcurrencyLimit: 10,
});
```

Enforcement happens server side and only applies to runs triggered with a `concurrencyKey`. Servers that have not enabled total concurrency limits accept the option but do not enforce it yet.
