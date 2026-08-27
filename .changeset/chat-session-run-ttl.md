---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Chat server sessions can now set a `ttl` on the runs they trigger, so a run that is never picked up expires instead of waiting indefinitely.
