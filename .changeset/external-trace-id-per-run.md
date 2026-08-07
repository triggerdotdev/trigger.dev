---
"@trigger.dev/core": patch
---

Mint the fallback external trace id per run rather than once per `TracingSDK`. Runs that carry no external trace context fall back to a generated trace id, and with `experimental_processKeepAlive` the `TracingSDK` outlives the run — so every run on a warm process was exported to the external OTLP endpoint under one shared trace id, merging unrelated runs into a single trace.
