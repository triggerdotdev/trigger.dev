---
"@trigger.dev/sdk": patch
"@trigger.dev/core": patch
---

Add `chat.store` — a typed, bidirectional shared data slot on `chat.agent`. Agent-side foundation for TRI-8602. Independent of AG-UI — the same primitive will back the AG-UI `STATE_SNAPSHOT` / `STATE_DELTA` translator later.

**New on the agent:**
- `chat.store.set(value)` — replace, emits a `store-snapshot` chunk on the existing chat output stream.
- `chat.store.patch([...])` — RFC 6902 JSON Patch, emits a `store-delta` chunk.
- `chat.store.get()` — read the current value (scoped to the run).
- `chat.store.onChange((value, ops) => ...)` — subscribe to changes.
- `hydrateStore?: (event) => value` config on `chat.agent` — mirrors `hydrateMessages`; restore the store after a continuation from your own persistence layer.
- `ChatTaskWirePayload.incomingStore` — optional wire field applied at turn start before `run()` fires (last-write-wins over `hydrateStore`).

**New in core:**
- `store-snapshot` / `store-delta` chunk types and `applyChatStorePatch` helper exported from `@trigger.dev/core/v3/chat-client`.

The store lives in memory for the lifetime of the run and is persisted by the existing chat output stream plus the `hydrateStore` hook across continuations — no new infrastructure.

Client-side pieces (transport `getStore` / `setStore` / `applyStorePatch` / listeners, `AgentChat` accessors, `useChatStore` React hook, reference demo, docs) land in a follow-up.
