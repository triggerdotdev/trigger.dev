---
"trigger.dev": patch
---

Deployed task telemetry now reports the deployment identifier (e.g. `deployment_abc123`) in the `worker.id` attribute, instead of an opaque internal value. Upgrade to get the readable identifier in your own OpenTelemetry exporters.
