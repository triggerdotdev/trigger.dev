---
"@trigger.dev/sdk": patch
---

Fix `chat.headStart` when `hydrateMessages` is registered. The warm route's step-1 partial now reaches the agent's accumulator on the hydrate path, so `onTurnComplete` carries the full first turn (the head-start user message included), tool-call handovers resume from step 2 instead of re-running step 1, and the assistant `messageId` stays stable across the handover.
