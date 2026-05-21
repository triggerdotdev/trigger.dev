---
"@trigger.dev/redis-worker": patch
---

Add `MollifierBuffer.listForEnvWithWatermark` for paginated, watermark-anchored reads of buffered entries newest-first. Implements the ZSET-based primitive that backs the mollifier listing merge in the webapp (Q1 design): `ZREVRANGEBYSCORE` strictly below the watermark score, with a tied-score band scan for entries sharing the watermark's `createdAtMicros`. Returns hydrated `BufferEntry` rows; orphans (queue ref without entry hash) are skipped silently.
