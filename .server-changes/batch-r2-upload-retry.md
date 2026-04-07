---
area: webapp
type: fix
---

Fix transient R2/object store upload failures during batchTrigger() item streaming.

- Added p-retry (3 attempts, 500ms–2s exponential backoff) around `uploadPacketToObjectStore` in `BatchPayloadProcessor.process()` so transient network errors self-heal server-side rather than aborting the entire batch stream.
- Removed `x-should-retry: false` from the 500 response on the batch items route so the SDK's existing 5xx retry path can recover if server-side retries are exhausted. Item deduplication by index makes full-stream retries safe.
