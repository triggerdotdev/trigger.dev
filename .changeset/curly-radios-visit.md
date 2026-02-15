---
"@trigger.dev/ai": minor
---

Add a new `@trigger.dev/ai` package with:

- `ai.tool(...)` and `ai.currentToolOptions()` helpers for AI SDK tool calling ergonomics
- a typed `TriggerChatTransport` that plugs into AI SDK UI `useChat()` and runs chat backends as Trigger.dev tasks
- rich default task payloads (`chatId`, trigger metadata, messages, request context) with optional payload mapping
- reconnect-aware stream handling on top of Trigger.dev Realtime Streams v2
- strict `baseURL` normalization/validation (trimming, path-safe slash handling, absolute `http(s)` URLs only, no query/hash/credentials)
