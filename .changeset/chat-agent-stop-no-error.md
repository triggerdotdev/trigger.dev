---
"@trigger.dev/sdk": patch
---

Stopping a `chat.agent` turn whose `run()` returns a `streamText` result no longer sends an `error` chunk with "An unexpected error occurred". The turn ends quietly again and the run stays alive for the next message.
