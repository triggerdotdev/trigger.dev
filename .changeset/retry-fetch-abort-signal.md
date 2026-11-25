---
"@trigger.dev/sdk": patch
---

Stop `retry.fetch` from retrying when aborted by the caller's `AbortSignal`, honor `Request.signal`, and reject immediately if the signal is already aborted.

