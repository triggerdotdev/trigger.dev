---
"@trigger.dev/sdk": patch
---

Add `chat.endRun()` — exits the run after the current turn completes, without the upgrade-required signal that `chat.requestUpgrade()` sends. Use when an agent finishes its work on its own terms (one-shot responses, goal achieved, budget exhausted) instead of waiting idle for the next user message. Call from `run()`, `chat.defer()`, `onBeforeTurnComplete`, or `onTurnComplete`.
