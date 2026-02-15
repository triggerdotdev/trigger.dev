---
"@trigger.dev/ai": minor
---

Add a new `@trigger.dev/ai` package with:

- `ai.tool(...)` and `ai.currentToolOptions()` helpers for AI SDK tool calling ergonomics
- a typed `TriggerChatTransport` that plugs into AI SDK UI `useChat()` and runs chat backends as Trigger.dev tasks
- rich default task payloads (`chatId`, trigger metadata, messages, request context) with optional payload mapping
- reconnect-aware stream handling on top of Trigger.dev Realtime Streams v2
- strict `baseURL` normalization/validation (trimming, path-safe slash handling, absolute `http(s)` URLs only, no query/hash/credentials)
- rejection of internal whitespace characters in normalized `baseURL` values
- rejection of internal invisible separator characters (e.g. zero-width/BOM characters) in normalized `baseURL` values
- rejection of invisible separator wrappers around otherwise valid `baseURL` values (for example `\u200B...` and `\u2060...`)
- deterministic baseURL validation error ordering for multi-issue inputs (internal whitespace → protocol → query/hash → credentials)
- explicit default `baseURL` behavior (`https://api.trigger.dev`) and case-insensitive `HTTP(S)` protocol acceptance
