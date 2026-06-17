---
"@trigger.dev/sdk": patch
"trigger.dev": patch
---

The agent skills installed by `trigger skills` are now namespaced with a `trigger-` prefix (e.g. `trigger-authoring-tasks`, `trigger-getting-started`) so they don't collide with unrelated skills in your coding agent's skills directory. Adds a `trigger-cost-savings` skill for auditing and reducing compute spend (right-sizing machines, `maxDuration`, batching, debounce), and `@trigger.dev/sdk` now bundles the full Trigger.dev documentation so your agent can read the complete, version-pinned reference directly from node_modules.
