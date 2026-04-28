---
"@trigger.dev/core": patch
---

Add `isReplay` boolean to the run context (`ctx.run.isReplay`), derived from the existing `replayedFromTaskRunFriendlyId` database field. Defaults to `false` for backwards compatibility.
