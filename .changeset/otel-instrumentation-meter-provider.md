---
"@trigger.dev/core": patch
---

Metrics from OpenTelemetry instrumentations in `trigger.config.ts` (such as HTTP, undici and pg) are now recorded and exported. Previously they were silently dropped. If you worked around this by calling `instrumentation.setMeterProvider(metrics.getMeterProvider())` in `init`, remove that call when you upgrade: rebinding again can register duplicate observable callbacks and skew values such as event loop utilization.
