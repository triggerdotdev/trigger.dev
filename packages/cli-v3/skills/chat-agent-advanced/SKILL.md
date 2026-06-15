---
name: chat-agent-advanced
description: >
  Advanced and operational chat.agent capabilities for Trigger.dev, loaded on demand. Load this when
  working on the raw Sessions primitive (sessions / SessionHandle), a custom chat transport or the
  realtime wire protocol, durable sub-agents (AgentChat, chat.stream.writer), human-in-the-loop,
  steering, actions, background injection (chat.defer / chat.inject), fast starts (preload, Head
  Start via @trigger.dev/sdk/chat-server), context resilience (compaction, recovery boot, OOM, large
  payloads), chat.local run-scoped state, offline testing with mockChatAgent, or prerelease/version
  upgrades. For the everyday chat.agent({...}) definition and the useTriggerChatTransport happy path,
  use the authoring-chat-agent skill instead.
type: core
library: trigger.dev
---

# chat.agent — advanced & operational

The full, version-pinned reference ships **inside your installed `@trigger.dev/sdk`**. Read it before writing code — it always matches the SDK version in this project, so it never drifts:

- **Skill:** `node_modules/@trigger.dev/sdk/skills/chat-agent-advanced/SKILL.md` — Sessions primitive, custom transports/wire protocol, sub-agents, HITL, steering, actions, background injection, fast starts, resilience (compaction/recovery/OOM/large payloads), `chat.local`, testing, upgrades.
- **Docs:** the full, version-pinned docs ship bundled at `node_modules/@trigger.dev/sdk/docs/ai-chat/` (including `patterns/` for HITL, sub-agents, sessions); the skill above lists the exact pages it draws from in its `sources:` frontmatter. Grep for an API, e.g. `grep -rl "mockChatAgent" node_modules/@trigger.dev/sdk/docs/`.

If those paths don't exist, `@trigger.dev/sdk` isn't installed yet — install it first. In a non-hoisted layout, resolve the package with `node -p "require.resolve('@trigger.dev/sdk/package.json')"` and read `skills/` + `docs/` beside it.

## Common mistakes

- **CRITICAL: sending a follow-up by re-POSTing `POST /api/v1/sessions`.**
  ```ts
  // Wrong - a cached re-POST silently drops basePayload.message; basePayload is trigger config, not a channel
  await fetch("/api/v1/sessions", { method: "POST", body: JSON.stringify({ ...createBody }) });
  // Correct - append to the session's input channel
  await fetch(`/realtime/v1/sessions/${id}/in/append`, { method: "POST", body: JSON.stringify({ kind: "message", payload }) });
  ```

- **Using the wrong token for `.in` / `.out`.** Use `publicAccessToken` from the create response
  body (session-scoped). The `x-trigger-jwt` response header is run-scoped and cannot subscribe.

- **Initializing `chat.local` in `onChatStart`.** It is skipped on continuation runs, so `run()`
  crashes with `chat.local can only be modified after initialization`. Init in `onBoot`.

- **`chat.defer` for the message-history write.** A mid-stream refresh would read `[]`. `await` that
  write inline before the model streams; reserve `chat.defer` for analytics, audit, cache warming.

- **Giving the HITL tool an `execute`.** `streamText` calls it immediately. Leave it execute-less;
  the frontend supplies the answer via `addToolOutput` + `sendAutomaticallyWhen`.

- **Declaring sub-agent / heavy tools only on `streamText`.** Also declare them on
  `chat.agent({ tools })` (or pass to `convertToModelMessages(uiMessages, { tools })` in a custom
  agent) so `toModelOutput` re-applies on every turn.

- **Importing heavy-execute tools into the Head Start route module.** This is a build-time import
  chain problem; runtime strip helpers do not fix it. Keep schemas in an `ai` + `zod`-only module.

- **Returning a megabyte tool output on the stream.** One `tool-output-available` record over ~1 MiB
  throws `ChatChunkTooLargeError`. Persist to your store, write the row first, then emit only an id.

- **Setting `X-Peek-Settled: 1` on the active-send path.** It races the new turn's first chunk and
  closes the stream early. Use it only on reconnect-on-reload paths.

> Note on docs vocabulary: agent-side examples in some docs still use the legacy
> `trigger:turn-complete` chunk type. That is the agent-emit vocabulary. A custom **reader** must
> filter on the `trigger-control` header, not on `chunk.type`.
>
> MCP-driven agent chats (`list_agents`, `start_agent_chat`, `send_agent_message`,
> `close_agent_chat`) are MCP server tools used from Claude Code / Cursor, not importable SDK
> functions. See `/mcp-tools#agent-chat-tools`.

## References

Sibling skills: **authoring-chat-agent** (the everyday `chat.agent({...})` happy path), **authoring-tasks** and **realtime-and-frontend** (task + frontend foundations).
