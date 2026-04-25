---
"@trigger.dev/sdk": patch
---

Three chat.agent fixes surfaced by smoke-testing the Sessions migration:

- **`chat.customAgent` now binds the session handle.** Previously only `chat.agent` set up the per-run `SessionHandle` in run-locals, so any custom agent that called `chat.messages.*`, `chat.stream.*`, `chat.createSession`, or `chat.createStopSignal` threw `chat.agent session handle is not initialized`. `chat.customAgent` now wraps the user's `run` function and opens the session via `payload.sessionId ?? payload.chatId` before invoking it, matching `chat.agent`'s behavior.
- **Stop mid-stream no longer hangs the turn loop.** When the user aborts a turn, the AI SDK's `runResult.totalUsage` promise can stay unresolved indefinitely on Anthropic streams, blocking `onTurnComplete` / `writeTurnComplete` / the next-message wait. The await is now raced against a 2s timeout (mirroring the existing `onFinishPromise` race), so a stuck `totalUsage` falls through to a non-fatal "usage unknown" path and the turn finalizes correctly.
- **New `chat.sessionId` getter.** Returns the friendlyId (`session_*`) of the run's backing Session. Useful in `onPreload` / `onChatStart` / `onTurnComplete` for persisting the session id alongside `runId` so reloads can resume the same conversation. Throws if called outside a chat.agent / chat.customAgent run.
