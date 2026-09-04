---
"@trigger.dev/sdk": patch
---

Steering messages injected mid-answer are now part of the conversation, both for your hooks and for the model on later turns. Previously they reached the model for the answer they steered and reached the browser, but nothing else: `onTurnComplete` never saw them, so an app storing its own transcript lost the instruction the answer was shaped by, and it vanished from the conversation on reload. The model also forgot the instruction from the next turn onwards, answering as though the message had never been sent, while the chat UI still showed it. This holds when the steered turn fails part-way, and when `pendingMessages.prepare` reshapes the message: later turns now see the same form the steered turn did, not the original message.

Approving a tool call no longer undoes compaction. A tool-approval continuation used to rebuild the model's context from the full conversation, so a chat that had been summarised to fit the context window was sent the whole transcript again on the next call, and could go over the limit it had just been compacted to avoid. The same applied to a regenerated answer that replaced an existing one.

If you worked around this by saving steering messages as they arrive, in `pendingMessages.onReceived` for example, that write now duplicates the one you get from `newUIMessages`. Drop it, or skip messages you have already stored.
