---
"@trigger.dev/sdk": patch
---

`TriggerChatTransport.reconnectToStream` no longer requires callers to persist an `isStreaming` flag in `ChatSession` state. Previously, any falsy `isStreaming` (including `undefined` when the flag was dropped from persistence) short-circuited reconnect to `null` and left the UI hanging on incomplete streams. Now the short-circuit only triggers on an explicit `isStreaming === false`, so callers can drop the flag entirely and let the server decide via the session's own `.out` tail. Existing callers that still persist `isStreaming` are unaffected.
