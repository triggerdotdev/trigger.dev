---
"@trigger.dev/core": patch
---

Realtime streams now reconnect and resume when the stream backend reports a failed read mid-stream, instead of ending early as if the stream had finished. This affects `runs.subscribeToRun` with streams, `useRealtimeRunWithStreams`, and chat streams.
