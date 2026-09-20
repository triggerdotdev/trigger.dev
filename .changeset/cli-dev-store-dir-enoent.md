---
"trigger.dev": patch
---

Ensure store directory exists before writing in createFileWithStore to prevent ENOENT crashes during dev session handover.
