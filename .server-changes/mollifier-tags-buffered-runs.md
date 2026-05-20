---
area: webapp
type: fix
---

`POST /api/v1/runs/{id}/tags` now handles buffered runs. Previously the route did `prisma.taskRun.update` after a `findFirst` that could miss; on buffered runs (no PG row yet) the update raised `RecordNotFound` and the route leaked as a 500 — the live drift the parity script flagged.

Switches the route to `mutateWithFallback` per the Q3 design. PG hits go through the existing select-dedupe-update flow with `MAX_TAGS_PER_RUN` enforcement. Buffered-QUEUED hits apply the `append_tags` patch on the snapshot (Lua-atomic dedup against existing tags). `busy` snapshots wait for drainer resolution then update PG normally. Genuine 404 / 503 surface as 404 / 503.

The `MAX_TAGS_PER_RUN` enforcement is skipped on the buffered side — the drainer's `engine.trigger` doesn't enforce it either, so behaviour matches the pre-buffer trigger path. Pushing the cap into the snapshot-mutate Lua is a possible follow-up.
