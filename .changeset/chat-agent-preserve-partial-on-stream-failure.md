---
"@trigger.dev/sdk": patch
---

Preserve the partial assistant message when a chat turn's model stream fails mid-response (e.g. a transport timeout). Previously the streamed-so-far output was dropped: `chat.agent`'s `onTurnComplete` fired with `responseMessage: undefined`, and `chat.createSession`'s `turn.complete()` rethrew without keeping the partial. Now the recovered partial is passed to `onTurnComplete` (on `responseMessage`, `uiMessages`, and `newUIMessages`) and accumulated before `turn.complete()` rethrows, so it survives for persistence even when `hydrateMessages` disables boot-time replay recovery. The turn is still reported as errored.
