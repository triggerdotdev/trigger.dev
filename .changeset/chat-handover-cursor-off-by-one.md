---
"@trigger.dev/core": patch
---

Fix a chunk occasionally dropped when a chat.agent run takes over from the warm first turn. The realtime stream writer now reports the inclusive last-written position as the resume cursor, so the agent's first record after the handover is no longer skipped.
