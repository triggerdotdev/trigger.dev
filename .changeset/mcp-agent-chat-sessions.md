---
"trigger.dev": patch
---

Migrate the MCP `start_agent_chat` / `send_agent_message` / `close_agent_chat` tools onto the Session primitive. The CLI MCP server now upserts a backing Session via `POST /api/v1/sessions` on chat start, threads `sessionId` through the run payload, sends messages to `session.in` as `ChatInputChunk { kind, payload }` JSON, and subscribes to `session.out` at `/realtime/v1/sessions/{sessionId}/out`. Scopes expanded from `write:inputStreams` to `read:sessions` + `write:sessions`. Upgrade-required re-trigger keeps the same session and swaps only `runId`.
