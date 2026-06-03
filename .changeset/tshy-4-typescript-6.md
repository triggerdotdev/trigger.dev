---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
"@trigger.dev/build": patch
"@trigger.dev/react-hooks": patch
"@trigger.dev/rsc": patch
"@trigger.dev/python": patch
"@trigger.dev/schema-to-json": patch
"trigger.dev": patch
---

Rebuild the published packages with tshy 4 and TypeScript 6. This is primarily an internal toolchain upgrade; the one user-facing fix is that the CLI now reports the HTTP status code on dev connection errors instead of leaving it blank.
