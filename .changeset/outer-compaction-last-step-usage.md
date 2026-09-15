---
"@trigger.dev/sdk": patch
---

chat.agent: the between-turns compaction check now receives the last step's token usage (the context the model actually held) instead of the turn's sum over every tool-calling step, so a single tool-using turn no longer compacts a short conversation. The summed figure is still available as `turnUsage` on the event. A head-start handover whose pending tool call completes under the same message id now replaces its spliced partial in the model lane directly instead of falling back to a full reconversion.
