---
"@trigger.dev/sdk": patch
---

Fixed a race where quickly restarting a chat stream could break stop and reconnect for the new stream.
