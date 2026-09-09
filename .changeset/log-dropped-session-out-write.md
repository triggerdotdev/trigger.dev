---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

A failed write to a realtime or chat session stream no longer crashes the process running it, and a dropped chat session output write is now logged instead of swallowed.
