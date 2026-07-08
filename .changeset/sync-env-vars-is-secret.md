---
"@trigger.dev/build": minor
"@trigger.dev/core": minor
"trigger.dev": minor
---

You can now mark environment variables synced via the `syncEnvVars` build extension as secrets. Return `{ name, value, isSecret: true }` from your callback and those variables are stored redacted in the dashboard, just like manually created secret env vars.
