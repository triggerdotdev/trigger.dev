---
"@trigger.dev/sdk": minor
"@trigger.dev/core": minor
---

Add `versionSkew: "follow-mid-turn"` to `chat.agent` and `chat.createSession`. It does everything `"follow"` does, and also moves a turn that is still running when its version is below the skew protection threshold: the turn finishes the step it is on, and a run on the current deployment continues the same reply from the next step, so no step runs twice and the person chatting sees one reply. `chat.handOverAtStep(step)` does the same from your own `prepareStep`. `chat.requestUpgrade()` called during a turn now moves the turn at the next step boundary instead of waiting for the turn to end. A turn is handed over only when the agent in the current deployment was built with this release or later; otherwise the turn finishes on its own version. If the API can't be reached during a handover, the old run keeps trying to start the next run for about three minutes, and a run that continues a chat while the API can't be reached waits for it rather than answer a message again.
