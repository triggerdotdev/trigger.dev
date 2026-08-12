---
"@trigger.dev/sdk": patch
---

Watch-mode chat streams now survive quiet windows and keep delivering later turns, and a reply cut off by a lost connection now shows an error instead of appearing finished. Aborting a resumed subscription no longer stops the run — it only closes your local stream, so a viewer leaving can't cut off someone else's reply. To stop generation, call `stopGeneration(chatId)`, or pass `stopOnAbort: true` to `reconnectToStream` when that subscriber owns the turn.
