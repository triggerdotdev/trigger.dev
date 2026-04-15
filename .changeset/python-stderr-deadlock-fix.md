---
"@trigger.dev/python": patch
---

Fix `python.runScript()` deadlock when the Python subprocess produces more than ~64KB of stderr output. The previous implementation hardcoded `OTEL_LOG_LEVEL: "DEBUG"` in the subprocess environment, which caused OTEL-aware Python libraries (mlflow, opentelemetry-sdk, etc.) to emit verbose debug-level logging to stderr during import. Once stderr exceeded the OS pipe buffer, the Python process would block on `write()` indefinitely. Removing the hardcoded debug log level brings `runScript()` in line with `run()`, `runInline()`, and the streaming variants — none of which set `OTEL_LOG_LEVEL`.
