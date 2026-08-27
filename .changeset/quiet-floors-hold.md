---
"@trigger.dev/sdk": patch
---

Fixes a message sent while the agent was mid-answer being lost if the run then crashed. The cursor written at the end of each turn could point past a message that had arrived during that turn but had not been answered yet, so the next boot skipped it and no error was raised anywhere. Such a message is now held until a turn actually takes it.

This also removes the in-memory buffer those messages used to sit in, on both `chat.agent` and `chat.createSession()`, so a message waiting for its turn is durable rather than only present in the worker that received it.
