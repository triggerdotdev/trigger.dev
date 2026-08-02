---
"@trigger.dev/sdk": patch
---

Fix a preloaded `chat.agent` run dropping an in-flight message when it retries after an out-of-memory error. The message being processed when the run hit the OOM is now recovered and re-run on the retry, instead of being skipped while the run waited for a new message.
