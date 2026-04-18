---
"@trigger.dev/sdk": patch
---

Expose `finishReason` on `TurnCompleteEvent` and `BeforeTurnCompleteEvent`. Surfaces the AI SDK's `FinishReason` (`"stop" | "tool-calls" | "length" | ...`) so hooks can distinguish a normal turn end from one paused on a pending tool call (HITL flows like `ask_user`). Undefined for manual `pipeChat()` or aborted streams.
