---
"@trigger.dev/sdk": patch
---

Fix `chat.agent` HITL continuations on reasoning-heavy turns. Two changes that work together:

- The per-turn merge now overlays the wire copy's tool-part state advancement onto the agent's existing chain — `state` + the matching resolution field (`output` / `errorText` / `approval`) come from the wire, everything else (text, reasoning, tool `input`, provider metadata) stays whatever the snapshot or `hydrateMessages` returned. Previously a full-message replace overwrote those fields with whatever the client shipped, so a slimmed wire copy landed a tool call with no `arguments` on the next LLM call. Covers `output-available` / `output-error` (HITL `addToolOutput`) and `approval-responded` / `output-denied` (approval flow).
- `TriggerChatTransport.sendMessages` and `AgentChat.sendRaw` now slim assistant messages that carry advanced tool parts. The wire payload is just `{ id, role, parts: [<state + resolution field>] }` for `submit-message` continuations; everything else passes through. Reasoning blobs and full tool inputs no longer ride the wire on every `addToolOutput` / `addToolApproveResponse`, so continuation payloads stay well under the `.in/append` cap on long agent loops.

Note: `onValidateMessages` receives the slim wire on HITL turns. If you call `validateUIMessages` from `ai` against the full `messages` array it will reject the slim assistant; filter to user messages (or skip on HITL turns) — see the updated docstring on `onValidateMessages` for the recommended pattern.

Net effect: `chat.addToolOutput(...)` / `chat.addToolApproveResponse(...)` on multi-step reasoning agents (OpenAI Responses with `store: false`, Anthropic extended thinking, etc.) no longer blows the cap and no longer corrupts the LLM input.
