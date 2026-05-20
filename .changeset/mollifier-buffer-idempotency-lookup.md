---
"@trigger.dev/redis-worker": patch
---

Add buffer-side idempotency-key dedup to `MollifierBuffer` per the Q5 mollifier-idempotency design. The `acceptMollifierEntry` Lua now SETNX-writes a `mollifier:idempotency:{envId}:{taskIdentifier}:{idempotencyKey}` lookup when the caller passes both an `idempotencyKey` and a `taskIdentifier`. Second accepts for the same tuple return `{ kind: "duplicate_idempotency", existingRunId }` so the loser can echo the winner's runId as a cached hit. `accept`'s return shape changes from `boolean` to a discriminated `AcceptResult` (`accepted` / `duplicate_run_id` / `duplicate_idempotency`).

New methods: `lookupIdempotency` (with stale-lookup self-heal) and `resetIdempotency` (atomic Lua that nulls `idempotencyKey` + `idempotencyKeyExpiresAt` on the snapshot payload, clears the denormalised hash pointer, and DELs the lookup). The drainer ack Lua now DELs the lookup atomically with marking the entry materialised — PG is canonical for the key post-materialisation.

`BufferEntrySchema` gains an optional `idempotencyLookupKey` field (the denormalised Redis lookup key string stored on the entry hash so the ack Lua can DEL it without reading the payload JSON).
