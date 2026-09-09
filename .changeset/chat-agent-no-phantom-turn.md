---
"@trigger.dev/sdk": patch
---

`chat.agent`: a continuation boot no longer re-dispatches the message that resumed it, and a turn with no new user message no longer calls the model. Previously a resumed run could answer the same message twice, and the second attempt failed against providers that reject a trailing assistant message, overwriting an answer that had already completed.
