---
"@trigger.dev/sdk": patch
---

Fixed a race where quickly restarting a chat stream could break stop and reconnect for the new stream. Stopping a chat now also hands it back to your other tabs instead of leaving them read-only.
