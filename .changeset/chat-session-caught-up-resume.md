---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Chat sessions now close a resumed stream as soon as it has caught up to the latest output, instead of holding the connection open for the full long-poll window. Reloading or reconnecting to an idle chat settles faster. This applies to the server-to-server `AgentChat` client's `reconnect()` too, not just the browser transport.
