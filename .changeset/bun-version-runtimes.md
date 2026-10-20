---
"@trigger.dev/core": patch
"@trigger.dev/rsc": patch
"trigger.dev": patch
---

Add `bun-1.3` (Bun 1.3.14) and `bun-1.4` (Bun 1.4.2) as `runtime` options in `trigger.config.ts`. Bun 1.3.x aborts any `fetch` that receives no bytes for 300 seconds, which fails long non-streaming calls such as LLM requests. Bun 1.4 does not have this limit, so set `runtime: "bun-1.4"` for those tasks. `runtime: "bun"` is unchanged and still deploys on Bun 1.3.3.

```ts
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  runtime: "bun-1.4",
  project: "<your-project-ref>",
});
```
