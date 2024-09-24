---
"@trigger.dev/core": patch
---

Add otel propagation headers "below" the API fetch span, to attribute the child runs with the proper parent span ID
