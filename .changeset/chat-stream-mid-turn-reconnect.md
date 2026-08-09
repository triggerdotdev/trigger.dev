---
"@trigger.dev/core": patch
"@trigger.dev/sdk": patch
---

Chat streams now reconnect when the connection drops mid-turn, instead of leaving the reply stuck as if it were still generating.
