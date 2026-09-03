---
"@trigger.dev/sdk": patch
---

`chat.inject()` with `role: "system"` now works. It previously put the system message into the conversation, which AI SDK 7 rejects for every provider: the next turn died with a generic "An error occurred." and persisted an empty assistant message, so the agent looked like it had stopped answering. System-role context is now appended to the model's instructions, which is also the only way to inject context the agent treats as trusted.

Two things to know. Instructions are delivered by `chat.toStreamTextOptions()`, so a `run()` that calls `streamText` without spreading it does not receive a system-role injection. The conversational lane has no such requirement. And an injection applies to the next turn only, rather than repeating on every turn that follows it. Every inference call in that turn sees it, so a `run()` that builds options more than once gets the same instructions each time.
