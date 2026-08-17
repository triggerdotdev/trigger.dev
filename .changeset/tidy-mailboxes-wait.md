---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Custom agent loops can now inspect pending chat input without consuming it and consume one mailbox record at a time with `chat.messages.hasPending()` and `chat.messages.next()`. Mailbox records include stable identifiers for tracing and redelivery.
