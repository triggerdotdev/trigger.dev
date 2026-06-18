---
"@trigger.dev/core": patch
---

Fix `@trigger.dev/core` build: cast the underlying log record exporter when calling `forceFlush` so it typechecks against the updated OpenTelemetry `LogRecordExporter` type (which no longer declares `forceFlush`).
