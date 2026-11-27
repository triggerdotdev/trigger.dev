---
area: webapp
type: feature
---

The remote MCP server can now show one deployment's details and one agent's details and activity, and its `trigger_task` tool accepts metadata, a concurrency key, named concurrency limits, debounce, a version to run on, priority and an idempotency key lifetime.

Triggering a task through the API or SDK with a very long idempotency key lifetime no longer fails; the key gets the default lifetime instead.
