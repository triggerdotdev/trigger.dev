import "../src/v3/test/index.js";

import { resourceCatalog, sessionStreams } from "@trigger.dev/core/v3";
import { runInMockTaskContext } from "@trigger.dev/core/v3/test";
import { describe, expect, it } from "vitest";
import { chat, type ChatTaskWirePayload } from "../src/v3/ai.js";

function userPayload(chatId: string, id: string): ChatTaskWirePayload {
  return {
    chatId,
    trigger: "submit-message",
    message: { id, role: "user", parts: [{ type: "text", text: id }] },
  };
}

/**
 * A worker process is reused across runs. The end of every run tears down the
 * channel subscription via `sessionStreams.clearHandlers()`, so a second run of
 * the same chat in the same process has to attach a fresh one. Anything cached
 * across runs that skips the attach leaves the new run with no input at all, and
 * the conversation hangs with no error raised.
 */
describe("chat input across runs in one warm process", () => {
  it("delivers messages to a second run of the same chat", async () => {
    const chatId = "warm-reuse";
    const seen: string[] = [];

    const agent = chat.customAgent({
      id: "chat-warm-process-reuse",
      run: async () => {
        const record = await chat.messages.next({ timeoutInSeconds: 2 });
        const part = record?.payload.message?.parts?.[0];
        if (part && part.type === "text") seen.push(part.text);
      },
    });
    const run = resourceCatalog.getTask(agent.id)?.fns.run;
    if (!run) throw new Error("custom agent was not registered");

    for (const attempt of ["first", "second"]) {
      await runInMockTaskContext(
        async (drivers) => {
          const runPromise = run(
            { chatId, trigger: "submit-message" },
            { ctx: drivers.ctx, signal: new AbortController().signal }
          );
          await drivers.sessions.in.send(
            chatId,
            { kind: "message", payload: userPayload(chatId, attempt) },
            "in"
          );
          await runPromise;
        },
        { ctx: { run: { id: `run_${attempt}` } } }
      );
      sessionStreams.clearHandlers();
    }

    expect(seen).toEqual(["first", "second"]);
  });
});
