---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

`AgentChat.reconnect()` now settles promptly when reconnecting to an idle chat instead of holding the connection open for the full long-poll window. Also upgrades the S2 streamstore client to 0.25 and moves realtime streams to S2's current hosts.
