---
"@trigger.dev/sdk": patch
---

Fix chat transport discarding the next turn after stopping generation. `skipToTurnComplete` is now reset when a new message or action is sent, so a message sent after `stopGeneration` streams normally instead of leaving the chat stuck in a streaming state.
