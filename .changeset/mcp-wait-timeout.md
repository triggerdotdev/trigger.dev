---
"trigger.dev": patch
---

Add optional `timeoutInSeconds` parameter to the `wait_for_run_to_complete` MCP tool. Defaults to 60 seconds. If the run doesn't complete within the timeout, the current state of the run is returned instead of waiting indefinitely.
