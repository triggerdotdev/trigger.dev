---
"@trigger.dev/sdk": patch
---

Fix two compaction problems on AI SDK 7. After a compaction, a `chat.agent` turn that continued a tool approval sent the model the full pre-compaction transcript instead of the summary, which undid the compaction (this also affected `chat.MessageAccumulator`). And between-turn compaction, in `chat.agent` and `chat.createSession`, was asked about the whole turn's token usage instead of the last step's, so `shouldCompact` thresholds triggered too early on multi-step turns.

If you call `compactIfNeeded` on a `chat.MessageAccumulator`, pass it the last step's usage, `(await result.steps).at(-1)?.usage`. `result.usage` is the turn's sum on AI SDK 7.
