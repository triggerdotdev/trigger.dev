---
area: webapp
type: improvement
---

Migrate the dashboard Agent tab (span inspector) to subscribe to the backing Session's `.out` and `.in` channels instead of the run-scoped chat output + chat-messages input streams. Pairs with the SDK + MCP migrations on the ai-chat branch.

- `SpanPresenter.server.ts` extracts `agentSession` from the run payload (prefers `sessionId`, falls back to `chatId` for pre-Sessions agent runs — matches `resolveSessionByIdOrExternalId`).
- Span route threads `agentSession` through `AgentViewAuth` and gates `agentView` creation on having one.
- New dashboard resource route `resources.orgs.../runs.$runParam/realtime/v1/sessions/$sessionId/$io` proxies `S2RealtimeStreams.streamResponseFromSessionStream` under dashboard session auth. The run param binds resource hierarchy; the session identity is verified against the environment.
- `AgentView.tsx` subscribes to `/out` and `/in` URLs, drops local `CHAT_STREAM_KEY`/`CHAT_MESSAGES_STREAM_ID` constants, and parses the `.in` stream as `ChatInputChunk` (`{kind: "message", payload}` for user turns; `{kind: "stop"}` ignored). Output-stream parsing is unchanged — session v2 SSE already delivers UIMessageChunk objects from `record.body.data`.
- Smoke: opened a prior `test-agent` run in the dashboard, Agent tab rendered user + assistant messages end-to-end with zero console errors. Both SSE endpoints (`/out`, `/in`) returned 200.
