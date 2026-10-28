---
"@trigger.dev/core": patch
---

The supervisor keeps its run notification subscriptions across reconnects to the webapp, and reconnects when the webapp turns its handshake away, so cancellations and resolved waits keep reaching running tasks after a webapp restart or deploy.
