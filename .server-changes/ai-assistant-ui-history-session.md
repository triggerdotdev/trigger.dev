---
area: webapp
type: improvement
---

Refinements to the AI assistant's navigation, docs, chat UI shell, and
session/history persistence:

- Sparkle hover animation on the Ask AI button and assistant header, plus a
  redesigned header close button (Button + ExitIcon + esc shortcut).
- AIChatPanel resumes an existing chat (`resume` flag) and always sends the
  current page context as `clientData` when starting a session.
- AIChatProvider history switching is guarded against out-of-order responses
  (a stale chat fetch can no longer clobber a newer selection), and sets
  messages before the chat id so `useChat` picks them up in one render.
- Session/history routes hardened: slug validation + error envelope in
  `resources.ai-assistant.ts`, and `resources.ai-assistant.history` now uses a
  typed Prisma query instead of raw SQL.
- `buildToolContext` validates required slugs.
- Chat persistence uses the platform `sessions.start()` API in the preload
  hooks with a lazy `aiChat` upsert in `onTurnStart`.
- Every completed tool call is shown as an agent step in the transcript (in the
  order the agent ran them), labelled with the tool's friendly name and
  expandable to reveal its input and output.
