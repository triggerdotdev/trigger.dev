---
"@trigger.dev/react-hooks": patch
"@trigger.dev/core": patch
---

Fixes an issue with realtime when re-subscribing to a run, that would temporarily display stale data and the changes. Now when re-subscribing to a run only the latest changes will be vended
