---
"@trigger.dev/sdk": patch
---

Fix a `chat.agent` turn failing after a head start that ended with two or more parallel tool calls. When those tools finished out of call order, the agent sent their results to the model twice on the next step, and the provider rejected the request (Anthropic: "each tool_use must have a single result"). Each handed-over tool result is now sent once.
