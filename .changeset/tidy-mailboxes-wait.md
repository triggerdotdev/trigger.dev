---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Custom agent loops can now inspect pending chat input without consuming it and consume one mailbox record at a time with `chat.messages.hasPending()` and `chat.messages.next()`. Mailbox records include stable identifiers for tracing and redelivery.

A control record that nothing on the run consumes is now discarded rather than left at the head of the `.in` channel, where it would have made every message queued behind it undeliverable. `chat.messages.next()` returning `undefined` means no message became consumable before the timeout.
