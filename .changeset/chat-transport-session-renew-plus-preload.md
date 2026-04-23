---
"@trigger.dev/sdk": patch
---

`TriggerChatTransport` fixes for session-scoped auth and end-to-end UI smoke parity:

- `RenewRunAccessTokenParams` now includes the durable `sessionId` alongside `chatId` + `runId`. Server-side renew handlers should mint the renewed PAT with `read:sessions:{sessionId}` + `write:sessions:{sessionId}` scopes (in addition to the existing run scopes) so it keeps authenticating against the session `.in` append + `.out` subscribe endpoints. Renewing without session scopes sends the transport into a 401 loop on the first append after expiry.
- `transport.preload(chatId)` on the `triggerTask` callback path no longer calls `apiClient.createSession` from the browser. The server action (e.g. `chat.createTriggerAction`) creates the session with its secret key and returns the `sessionId` in its result, matching how `sendMessages` already worked. Browser deployments that use the `triggerTask` callback path therefore no longer need `write:sessions` on any browser-side token.
