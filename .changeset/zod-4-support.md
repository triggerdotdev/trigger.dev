---
"@trigger.dev/build": minor
"@trigger.dev/core": minor
"@trigger.dev/react-hooks": minor
"@trigger.dev/rsc": minor
"@trigger.dev/sdk": minor
"trigger.dev": minor
"@trigger.dev/redis-worker": minor
"@trigger.dev/schema-to-json": minor
---

Trigger.dev now uses Zod 4 by default. Projects using Zod 3.25.56 or later 3.x releases remain supported.

Zod remains a runtime dependency of packages that execute schemas, so existing and new installations continue to receive it automatically. The matching peer dependency range allows package managers to reuse either a compatible Zod 3 or Zod 4 installation from your project.
