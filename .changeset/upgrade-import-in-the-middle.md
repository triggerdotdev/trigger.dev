---
"trigger.dev": patch
---

Upgrade import-in-the-middle from 1.11.0 to 3.0.0 to fix the `importAssertions` deprecation warning on Node.js v21+, v20.10.0+, and v18.19.0+.

This resolves the error: `Use importAttributes instead of importAssertions` that occurred when using certain OpenTelemetry instrumentations like `UndiciInstrumentation`, `HttpInstrumentation`, and `AwsInstrumentation`.
