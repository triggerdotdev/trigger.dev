---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Run multiple SDK clients side-by-side. `new TriggerClient({...})` exposes the management API as an explicit instance with its own auth, preview branch, and baseURL, so a single process can trigger tasks across different projects, environments, or preview branches without mutating shared global state.

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

Instance calls are isolated by default: identity fields (auth, branch) and task-runtime reads (`parentRunId`, `lockToVersion`, `taskContext.ctx`) are scope-only, so a call from inside a task does not leak parent context into a trigger that hits a different project. `baseURL` still falls back to `TRIGGER_API_URL` so local-dev and CI overrides apply without forcing every consumer to pass it explicitly.

Also fixes `configure()` silently no-op-ing on the second call, and makes `auth.withAuth()` concurrency-safe (parallel calls with different configs no longer stomp each other).
