---
"trigger.dev": patch
"@trigger.dev/core": patch
---

Fixes an issue that caused failed tasks when resuming after calling `triggerAndWait` or `batchTriggerAndWait` in prod/staging (this doesn't effect dev).

The version of Node.js we use for deployed workers (latest 20) would crash with an out-of-memory error when the checkpoint was restored. This crash does not happen on Node 18x or Node21x, so we've decided to upgrade the worker version to Node.js21x, to mitigate this issue.

You'll need to re-deploy to production to fix the issue.
