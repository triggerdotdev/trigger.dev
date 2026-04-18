---
"@trigger.dev/core": patch
---

Add `runInMockTaskContext` test harness at `@trigger.dev/core/v3/test` for unit-testing task code offline. Installs in-memory managers for `locals`, `lifecycleHooks`, `runtime`, `inputStreams`, and `realtimeStreams`, plus a mock `TaskContext`, so tasks can be driven end-to-end without hitting the Trigger.dev runtime. Provides drivers to send data into input streams and inspect chunks written to output streams.
