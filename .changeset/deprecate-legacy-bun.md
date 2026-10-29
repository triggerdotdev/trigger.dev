---
"trigger.dev": patch
"@trigger.dev/core": patch
---

Deprecates the legacy Bun runtime. `runtime: "bun"` (and its explicit spelling `"bun-legacy"`), which deploys Bun 1.3.3 with Node.js 20 alongside it, now prints a deprecation warning, and deploys that use it will be rejected from January 5, 2027. Switch to `runtime: "bun-1.4"` (Bun 1.4.4 on an image with no Node.js binary) and redeploy.
