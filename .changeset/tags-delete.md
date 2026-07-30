---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
"@trigger.dev/redis-worker": patch
---

You can now remove tags from a run while it's running with `tags.delete("my-tag")` (or an array of tags). It only affects that run — every other run keeps the tag, and the tag stays available to filter by.
