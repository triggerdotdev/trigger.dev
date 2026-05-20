---
"@trigger.dev/redis-worker": patch
---

Add `MollifierBuffer.casSetMetadata` — optimistic-lock metadata write for buffered runs. Adds a `metadataVersion` field to the entry hash; the Lua refuses the write if the expected version has moved, returning `{ kind: "version_conflict", currentVersion }` so the caller can retry. Mirrors the PG-side `UpdateMetadataService` retry-on-conflict pattern, so concurrent `metadata.increment` / `metadata.append` / `metadata.set` calls against a buffered run never lose deltas.
