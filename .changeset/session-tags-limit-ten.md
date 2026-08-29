---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Session `triggerConfig.tags` now accepts up to 10 tags, matching the run tag limit. Previously it was capped at 5, which for `chat.agent` left room for only 4 of your own tags after the automatic `chat:{chatId}` tag.
