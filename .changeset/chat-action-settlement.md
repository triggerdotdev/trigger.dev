---
"@trigger.dev/sdk": patch
---

Add an optional `onSettled` callback to `TriggerChatTransport.sendAction()` so callers can confirm that their action's input was processed, independently of whether the response stream closes.
