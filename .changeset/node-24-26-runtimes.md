---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Add `node-24` and `node-26` as supported `runtime` options in `trigger.config.ts`. The `experimental-node-24` and `experimental-node-26` names are now deprecated aliases and emit a deprecation warning; switch to `node-24` / `node-26` instead.

```ts
import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  runtime: "node-24",
  project: "<your-project-ref>",
});
```
