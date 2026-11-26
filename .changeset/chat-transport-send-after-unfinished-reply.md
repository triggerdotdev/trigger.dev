---
"@trigger.dev/sdk": patch
---

A chat message sent while an earlier reply is still running, for example after Stop on a reply resumed after a reload, now gets only its own answer instead of the rest of that reply and an error.
