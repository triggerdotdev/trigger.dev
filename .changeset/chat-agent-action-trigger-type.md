---
"@trigger.dev/sdk": patch
---

Include `"action"` in the `ChatTaskPayload.trigger` union. `run()` is invoked with `trigger: "action"` after `onAction` processes a typed action, but the type previously omitted it. Users can now cleanly short-circuit the LLM call for actions that don't need a response (e.g. user-initiated compaction): `if (trigger === "action") return;`.
