---
"trigger.dev": patch
---

Stop logging task run environment variable values at debug level. The `initializing task run process` debug log previously serialized the full worker environment, which includes `TRIGGER_SECRET_KEY`, `TRIGGER_JWT`, and any secret env vars set for the run. It now logs only the env var names, so secrets no longer appear in run logs when debug logging is enabled.
