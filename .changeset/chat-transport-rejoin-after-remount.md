---
"@trigger.dev/sdk": patch
---

With AI SDK 7's `useChat({ resume: true })`, a chat that remounts while a reply is still streaming (for example under React StrictMode in development) now rejoins the reply from its start instead of showing nothing until the next message.
