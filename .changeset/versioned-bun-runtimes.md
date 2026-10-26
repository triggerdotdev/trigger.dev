---
"trigger.dev": patch
"@trigger.dev/core": patch
"@trigger.dev/rsc": patch
---

Adds the `bun-1.4` runtime. `runtime: "bun-1.4"` deploys on Bun 1.4.4 in a Bun-only image with no Node.js binary, and the run controller itself runs under Bun. `runtime: "bun"` is unchanged (Bun 1.3 with Node.js alongside it); `bun-legacy` is accepted as an explicit spelling of the same runtime. On Bun 1.4 the worker no longer crashes at startup on the `--no-warnings=ExperimentalWarning` flag.
