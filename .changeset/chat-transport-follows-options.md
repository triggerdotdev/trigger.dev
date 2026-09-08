---
"@trigger.dev/sdk": patch
---

`useTriggerChatTransport` now picks up changes to `accessToken`, `startSession` and `fetch` on re-render, so a chat that stays mounted while the surrounding page changes no longer keeps sending to the endpoint captured on first render.
