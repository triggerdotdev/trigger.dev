---
"@trigger.dev/sdk": patch
---

chat.agent transcript fixes: a turn that errors before the model produces any content no longer stores an empty assistant message, an error thrown without a message now shows a generic error instead of a blank one, and a custom transcript storage no longer needs to preserve exact message JSON for a compaction to survive a continuation.
