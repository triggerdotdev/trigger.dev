---
"@trigger.dev/sdk": patch
---

A response streamed back from `onAction` is now part of the conversation. Returning a `StreamTextResult` from an action sent it to the browser and nowhere else, so a regenerate showed the user a new answer that the model had no memory of — the next turn carried on from the answer that had just been replaced.

A stream that fails part-way through is also no longer committed as though it finished. Whatever streamed is still kept, but the failure is reported instead of the truncated text being stored, and built on, as a complete answer.
