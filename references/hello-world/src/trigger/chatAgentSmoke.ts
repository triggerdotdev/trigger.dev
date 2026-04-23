import { logger, sessions, task, tasks } from "@trigger.dev/sdk";

/**
 * End-to-end smoke test for the chat.agent -> Sessions migration.
 *
 * Flow:
 *   1. Create a Session with a deterministic externalId so the
 *      `test-agent` run can `sessions.open(...)` it on startup.
 *   2. Trigger `test-agent` with `{chatId, sessionId, messages, trigger,
 *      metadata}` — mirrors what TriggerChatTransport would send for a
 *      first message, minus the browser-triggered access token layer.
 *   3. `session.out.read({...})` — consume the agent's UIMessageChunks
 *      as they stream out. Bail after the first text-delta (good
 *      enough to prove output flow + SSE subscription).
 *   4. `sessions.close(...)` — tidy up.
 *
 * Trigger from the dashboard or MCP:
 *
 *   mcp__trigger__trigger_task(taskId: "chat-agent-smoke", payload: {})
 *
 * Expects OPENAI_API_KEY set in the env (the test-agent uses
 * `openai:gpt-4o-mini`). If the key is missing the smoke reports an
 * error payload without crashing.
 */
export const chatAgentSmoke = task({
  id: "chat-agent-smoke",
  run: async () => {
    const stamp = Date.now();
    const chatId = `chat-agent-smoke-${stamp}`;

    logger.info("creating chat.agent backing session", { externalId: chatId });
    const session = await sessions.create({
      type: "chat.agent",
      externalId: chatId,
      tags: ["chat-agent-smoke"],
    });

    logger.info("triggering test-agent run", {
      chatId,
      sessionId: session.id,
    });
    await tasks.trigger("test-agent", {
      chatId,
      sessionId: session.id,
      trigger: "submit-message",
      messages: [
        {
          id: `m-${stamp}`,
          role: "user",
          parts: [{ type: "text", text: "Say hello in five words." }],
        },
      ],
      metadata: { userId: "smoke", model: "openai:gpt-4o-mini" },
    });

    logger.info("subscribing to session.out, waiting for first chunks");
    const handle = sessions.open(session.id);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);

    const received: Array<{ type?: string; id?: string }> = [];
    let firstTextDelta: string | undefined;
    let turnCompleteSeen = false;

    try {
      const stream = await handle.out.read<Record<string, unknown>>({
        signal: controller.signal,
        timeoutInSeconds: 30,
        // Start from seq 0 so we don't race the agent's early writes.
        lastEventId: "-1",
        onPart: (part) => {
          // Record the event id alongside the chunk so we can see the
          // full sequence that came down the wire.
          received.push({
            id: part.id,
            type: (part.chunk as { type?: string } | null)?.type,
          });
        },
      });

      for await (const chunk of stream) {
        if (chunk.type === "text-delta" && typeof chunk.delta === "string") {
          firstTextDelta ??= chunk.delta;
        }
        if (chunk.type === "trigger:turn-complete") {
          turnCompleteSeen = true;
          break;
        }
        if (received.length > 500) break;
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") throw err;
    } finally {
      clearTimeout(timeout);
    }

    await sessions.close(session.id, { reason: "chat-agent-smoke-done" });

    return {
      ok: received.length > 0,
      chatId,
      sessionId: session.id,
      chunkCount: received.length,
      firstTextDelta,
      turnCompleteSeen,
      types: [...new Set(received.map((c) => c.type ?? "<unknown>"))],
      firstFiveIds: received.slice(0, 5).map((c) => `${c.id}:${c.type ?? "<u>"}`),
      lastFiveIds: received.slice(-5).map((c) => `${c.id}:${c.type ?? "<u>"}`),
    };
  },
});
