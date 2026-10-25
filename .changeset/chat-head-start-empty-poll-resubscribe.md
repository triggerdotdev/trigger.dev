---
"@trigger.dev/sdk": patch
---

Fix `chat.headStart` relay ending the first turn after an empty `session.out` long-poll window. Resubscribes across empty windows until `turn-complete` with exponential jittered backoff.
