---
"@trigger.dev/sdk": patch
---

Fix `chat.agent` channels on AI SDK 7 failing the whole turn when a channel file can't be downloaded. A file the connector owns but can't read is now replaced with an `[Attached file "…" could not be loaded]` note and the agent still answers, as it does on AI SDK 6. AI SDK 7 describes a file's URL in a tagged form that the SDK didn't recognise, so the failed file was never found.

An inline `data:` file in a channel message is no longer passed to a connector's `download`, and on AI SDK 6 it reaches the model instead of failing the turn.
