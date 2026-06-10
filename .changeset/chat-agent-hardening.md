---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Reliability fixes for `chat.agent`. A user message sent while the agent is streaming is no longer delivered twice (which could run a duplicate turn), input appends now carry an idempotency key so a retried send can't duplicate a message, stopping a generation clears the streaming state so a page reload doesn't replay the stopped turn, and runs can now carry the full set of dashboard tags instead of being silently truncated. `onTurnComplete` now fires on errored turns (with the thrown error attached) and the failed turn's user message is persisted so it isn't lost on the next run. Custom agents and manual `chat.writeTurnComplete` callers now trim the output stream, sending a custom action no longer leaves a second stream reader running, and a long-lived `watch` subscription no longer grows its dedupe set without bound.
