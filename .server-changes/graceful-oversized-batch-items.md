---
area: webapp
type: fix
---

Gracefully handle oversized batch items instead of aborting the stream.

When an NDJSON batch item exceeds the maximum size, the parser now emits an error marker instead of throwing, allowing the batch to seal normally. The oversized item becomes a pre-failed run with `PAYLOAD_TOO_LARGE` error code, while other items in the batch process successfully. This prevents `batchTriggerAndWait` from seeing connection errors and retrying with exponential backoff.

Also fixes the NDJSON parser not consuming the remainder of an oversized line split across multiple chunks, which caused "Invalid JSON" errors on subsequent lines.
