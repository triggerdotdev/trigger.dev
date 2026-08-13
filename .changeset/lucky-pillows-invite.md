---
"@trigger.dev/core": patch
---

Task metrics no longer go missing for projects that configure their own `metricExporters` or `metricReaders`, and the flush error that came with it is gone.
