---
"@trigger.dev/core": patch
---

Add a `@trigger.dev/core/v3/telnetLogServer` module: the shared `TelnetLogServer` (localhost-only, backpressure-safe), `formatLogLine`, and `stripAnsi` helpers, plus an optional static `Logger.onLog` / `SimpleStructuredLogger.onLog` sink used to fan structured logs out to a local dev-only telnet/TCP stream.
