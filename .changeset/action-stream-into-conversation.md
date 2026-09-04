---
"@trigger.dev/sdk": patch
---

A response streamed back from `onAction` is now part of the conversation. Returning a `StreamTextResult` from an action sent it to the browser and nowhere else, so a regenerate showed the user a new answer that the model had no memory of, and the next turn carried on from the answer it had replaced.

A stream that fails part-way through is also no longer committed as though it finished. Whatever streamed is still kept, but the failure is reported instead of the truncated text being stored, and built on, as a complete answer. An action that used to end quietly on a mid-stream failure now surfaces an error to the frontend. It is still an action, not a turn: `onTurnComplete` does not fire for it, the turn count is unchanged, and an instruction injected for the next turn still reaches that turn.
