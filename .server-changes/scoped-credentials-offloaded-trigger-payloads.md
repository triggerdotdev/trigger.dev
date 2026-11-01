---
area: webapp
type: fix
---

Triggering a task with a payload over the offload threshold from inside a running task works again. Run-scoped tokens and restricted API keys upload offloaded payloads into their own namespace and may only trigger with payloads they uploaded, while pointers at other runs' stored payloads or outputs are still rejected.
