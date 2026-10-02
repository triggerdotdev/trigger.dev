---
"@trigger.dev/sdk": patch
---

Recovering a long unfinished `chat.agent` response on a continuation run no longer blocks the worker. Rebuilding the response from its streamed chunks now takes time linear in its length and yields to the event loop as it goes, so heartbeats keep firing and the run is not killed mid-replay. Capturing the response at the end of a long turn gets the same speedup.
