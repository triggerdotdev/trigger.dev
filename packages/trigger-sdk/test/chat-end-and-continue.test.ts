import "../src/v3/test/index.js";

import { apiClientManager, resourceCatalog } from "@trigger.dev/core/v3";
import { runInMockTaskContext } from "@trigger.dev/core/v3/test";
import { describe, expect, it, vi } from "vitest";
import { chat } from "../src/v3/ai.js";

describe("chat.endAndContinue", () => {
  it("rejects calls outside a custom agent run", async () => {
    await expect(chat.endAndContinue()).rejects.toThrow(
      "chat.endAndContinue() can only be called from inside a chat.customAgent() run"
    );
  });

  it("rejects while a createSession iterator is active and allows handoff after return", async () => {
    const chatId = "end-and-continue-active-session";
    const endAndContinueSession = vi.fn().mockResolvedValue({});
    const clientSpy = vi.spyOn(apiClientManager, "clientOrThrow").mockReturnValue({
      readSessionStreamRecords: async () => ({ records: [] }),
      endAndContinueSession,
    } as never);

    const agent = chat.customAgent({
      id: "end-and-continue-active-session-agent",
      run: async (payload, { signal }) => {
        const iterator = chat.createSession(payload, { signal })[Symbol.asyncIterator]();
        const firstTurn = await iterator.next();
        expect(firstTurn.done).toBe(false);

        await expect(chat.endAndContinue()).rejects.toThrow(
          "chat.endAndContinue() cannot be called while a chat.createSession() iterator is active. Use chat.requestUpgrade() instead."
        );
        expect(endAndContinueSession).not.toHaveBeenCalled();

        await iterator.return?.();
        await chat.endAndContinue();
      },
    });
    const run = resourceCatalog.getTask(agent.id)?.fns.run;
    if (!run) throw new Error("custom agent was not registered");

    try {
      await runInMockTaskContext((drivers) =>
        run(
          {
            chatId,
            trigger: "submit-message",
            message: {
              id: "user-1",
              role: "user",
              parts: [{ type: "text", text: "hello" }],
            },
          },
          { ctx: drivers.ctx, signal: new AbortController().signal }
        )
      );

      expect(endAndContinueSession).toHaveBeenCalledOnce();
      expect(endAndContinueSession).toHaveBeenCalledWith(chatId, {
        callingRunId: "run_test",
        reason: "upgrade",
      });
    } finally {
      clientSpy.mockRestore();
    }
  });
});
