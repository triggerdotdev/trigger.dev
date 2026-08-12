---
"@trigger.dev/sdk": patch
---

Watch-mode chat streams now survive quiet windows and page reloads, and a reply cut off by a lost connection shows an error instead of appearing finished. Aborting a resumed subscription only closes your local stream — call `stopGeneration(chatId)` or pass `stopOnAbort: true` to stop the run. Also fixed a race where quickly restarting a stream could break stop and reconnect, and stopping a chat now hands it back to your other tabs instead of leaving them read-only.
