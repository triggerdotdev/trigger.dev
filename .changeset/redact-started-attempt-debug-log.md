---
"trigger.dev": patch
---

Stop logging project environment variable values in the managed run controller's "started attempt" debug log. The entry now records run/snapshot identifiers and the environment variable **names** only.
