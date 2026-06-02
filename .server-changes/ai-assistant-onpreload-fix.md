---
area: webapp
type: fix
---

Fix the dashboard AI assistant (`dashboard-assistant` chat.agent) silently not
responding to messages. The session is started via `chat.createStartSessionAction`,
which triggers the first run with `trigger: "preload"`, so every chat boots
preloaded. The agent only created its `AiChat`/`AiChatSession` rows in
`onChatStart`, which early-returns on preloaded runs — so the rows were never
created and `onTurnStart`'s `aiChat.update(...)` threw before `run()` streamed.

Adds an `onPreload` hook that creates the rows (with `onChatStart` kept as the
non-preloaded fallback), and declares `tools` on the agent config (function form)
read back from the `run()` payload so the SDK re-applies each tool's
`toModelOutput` when re-converting history on later turns.
