---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

`runs.replay()` now takes options, so you can replay a run with a different payload, metadata, tags, queue, machine, version, delay and other trigger options. Anything you leave out comes from the original run, as before, and the payload is serialized like `trigger()`, so values like `Date` and `BigInt` keep their types.

```ts
import { runs } from "@trigger.dev/sdk";

await runs.replay("run_1234", {
  payload: { userId: "user_456" },
  tags: ["replayed"],
  delay: "10m",
});
```
