---
"@trigger.dev/core": patch
"trigger.dev": patch
---

Fix dev workers spinning at 100% CPU after the parent CLI disconnects. Orphaned `trigger-dev-run-worker` (and indexer) processes were caught in an `uncaughtException` feedback loop: a periodic IPC send via `process.send` would throw `ERR_IPC_CHANNEL_CLOSED` once the parent closed the channel, which re-entered the same handler that itself called `process.send`, scheduled via `setImmediate` and amplified by source-map-support's `prepareStackTrace`. Fixed by (1) silently dropping packets in `ZodIpcConnection` when the channel is disconnected, (2) adding a `process.on("disconnect", ...)` handler in dev workers so they exit cleanly when the CLI closes the IPC channel, and (3) wrapping all `uncaughtException`-path `process.send` calls in a `safeSend` guard that checks `process.connected` and swallows synchronous throws.
