---
"@trigger.dev/sdk": patch
"@trigger.dev/react-hooks": patch
---

Add input streams for bidirectional communication with running tasks. Define typed input streams with `streams.input<T>({ id })`, then consume inside tasks via `.wait()` (suspends the process), `.once()` (waits for next message), or `.on()` (subscribes to a continuous stream). Send data from backends with `.send(runId, data)` or from frontends with the new `useInputStreamSend` React hook.

Upgrade S2 SDK from 0.17 to 0.22 with support for custom endpoints (s2-lite) via the new `endpoints` configuration, `AppendRecord.string()` API, and `maxInflightBytes` session option.
