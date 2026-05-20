---
"@trigger.dev/redis-worker": patch
---

Add `MollifierBuffer.mutateSnapshot(runId, patch)` — atomic Lua-driven snapshot mutation for the burst-buffer entry hash. Supports four patch types: `append_tags` (with dedup), `set_metadata`, `set_delay`, `mark_cancelled`. Returns one of three result codes: `applied_to_snapshot` (entry was QUEUED and not materialised), `not_found` (no entry hash), or `busy` (DRAINING / FAILED / materialised — caller wait-and-bounces through PG per Q3 design).
