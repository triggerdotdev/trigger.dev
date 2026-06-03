---
"@trigger.dev/sdk": patch
---

Fix `chat.agent` HITL continuations on reasoning-heavy turns. Two changes that work together:

- The per-turn merge now overlays the wire copy's tool-part state advancement onto the agent's existing chain — `state` + the matching resolution field (`output` / `errorText` / `approval`) come from the wire, everything else (text, reasoning, tool `input`, provider metadata) stays whatever the snapshot or `hydrateMessages` returned. Previously a full-message replace overwrote those fields with whatever the client shipped, so a slimmed wire copy landed a tool call with no `arguments` on the next LLM call. Covers `output-available` / `output-error` (HITL `addToolOutput`) and `approval-responded` / `output-denied` (approval flow).
- `TriggerChatTransport.sendMessages` and `AgentChat.sendRaw` now slim assistant messages that carry advanced tool parts. The wire payload is just `{ id, role, parts: [<state + resolution field>] }` for `submit-message` continuations; everything else passes through. Reasoning blobs and full tool inputs no longer ride the wire on every `addToolOutput` / `addToolApproveResponse`, so continuation payloads stay well under the `.in/append` cap on long agent loops.

Note: `onValidateMessages` receives the slim wire on HITL turns. If you call `validateUIMessages` from `ai` against the full `messages` array it will reject the slim assistant; filter to user messages (or skip on HITL turns) — see the updated docstring on `onValidateMessages` for the recommended pattern.

For `hydrateMessages` hooks that persist the chain, this release also adds a small helper to the `@trigger.dev/sdk/ai` surface:

```ts
import { chat, upsertIncomingMessage } from "@trigger.dev/sdk/ai";

chat.agent({
  hydrateMessages: async ({ chatId, trigger, incomingMessages }) => {
    const record = await db.chat.findUnique({ where: { id: chatId } });
    const stored = record?.messages ?? [];
    if (upsertIncomingMessage(stored, { trigger, incomingMessages })) {
      await db.chat.update({ where: { id: chatId }, data: { messages: stored } });
    }
    return stored;
  },
});
```

It pushes fresh user messages by id, no-ops on HITL continuations (the incoming shares an id with the existing assistant — the runtime overlays the new tool-state advance), and skips on non-`submit-message` triggers. Returns `true` if it mutated `stored` so the caller knows whether to persist.

Net effect: `chat.addToolOutput(...)` / `chat.addToolApproveResponse(...)` on multi-step reasoning agents (OpenAI Responses with `store: false`, Anthropic extended thinking, etc.) no longer blows the cap and no longer corrupts the LLM input.
