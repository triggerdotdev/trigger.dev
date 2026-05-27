---
"@trigger.dev/sdk": patch
---

Add `TriggerClient` for running multiple SDK clients side-by-side, each with its own auth, preview branch, and baseURL. Useful when a single process needs to trigger tasks or read runs across multiple projects, environments, or preview branches without mutating shared global state.

```ts
import { TriggerClient } from "@trigger.dev/sdk";

const prod = new TriggerClient({ accessToken: process.env.TRIGGER_PROD_KEY });
const preview = new TriggerClient({
  accessToken: process.env.TRIGGER_PREVIEW_KEY,
  previewBranch: "signup-flow",
});

await prod.tasks.trigger("send-email", payload);
await preview.runs.list({ status: ["COMPLETED"] });
```
