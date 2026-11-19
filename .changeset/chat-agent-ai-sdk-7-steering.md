---
"@trigger.dev/sdk": patch
---

Fix `chat.agent` steering on AI SDK 7. A steering message that `pendingMessages.prepare` turns into a `system` message no longer makes the step fail with an invalid-prompt error: `chat.toStreamTextOptions()` now sets `allowSystemInMessages: true`, as AI SDK 5 and 6 already behave (pass `allowSystemInMessages: false` after the spread to keep AI SDK 7's strict default). A turn whose stream ends on an error now reports `finishReason: "error"` in `onTurnComplete`, where it could be `undefined` or the previous step's reason.
