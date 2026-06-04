---
"@trigger.dev/redis-worker": patch
---

Mollifier `mutateSnapshot` now enforces a tag cap: an `append_tags` patch carrying `maxTags` returns `"limit_exceeded"` (writing nothing) when the deduped tag count would exceed the limit, so a buffered run can't accumulate more tags via the tags API than the trigger validator allows at creation.
