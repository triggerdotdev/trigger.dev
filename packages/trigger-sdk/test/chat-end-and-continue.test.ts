// Import the test entry point first so chat.customAgent() registers its task.
import "../src/v3/test/index.js";

import { afterEach, describe, expect, it, vi } from "vitest";
import { apiClientManager, resourceCatalog } from "@trigger.dev/core/v3";
import { runInMockTaskContext, TestSessionStreamManager } from "@trigger.dev/core/v3/test";
import { chat } from "../src/v3/ai.js";

const CHAT_ID = "chat-end-and-continue";
const CALLING_RUN_ID = "run_before_handoff";
const CONTINUATION_RUN_ID = "run_after_handoff";

class DurableTestSessionStreamManager extends TestSessionStreamManager {
  override reset(): void {
    // The Session stream outlives either task run. Drop run-local listeners,
    // but preserve buffered input for the continuation run.
    this.clearHandlers();
  }

  dispose(): void {
    super.reset();
  }
}

describe("chat.endAndContinue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ends cleanly and leaves pending input for the continuation run", async () => {
    let continuationMessage: unknown;

    const agent = chat.customAgent({
      id: "end-and-continue-custom-agent",
      run: async (payload) => {
        if (!payload.continuation) {
          return chat.endAndContinue();
        }

        const next = await chat.messages.waitWithIdleTimeout({
          idleTimeoutInSeconds: 1,
          timeout: "1m",
        });
        if (!next.ok) {
          throw next.error;
        }

        continuationMessage = next.output.message;
      },
    });

    const taskEntry = resourceCatalog.getTask(agent.id);
    expect(taskEntry).toBeDefined();
    const runFn = taskEntry!.fns.run as (
      payload: Record<string, unknown>,
      options: { ctx: unknown; signal: AbortSignal }
    ) => Promise<unknown>;

    const readSessionStreamRecords = vi.fn(async () => ({ records: [] }));
    const endAndContinueSession = vi.fn(async () => ({
      runId: CONTINUATION_RUN_ID,
      swapped: true,
    }));
    vi.spyOn(apiClientManager, "clientOrThrow").mockReturnValue({
      readSessionStreamRecords,
      endAndContinueSession,
    } as never);

    const sessionStreams = new DurableTestSessionStreamManager();
    const pendingPayload = {
      chatId: CHAT_ID,
      trigger: "submit-message",
      message: {
        id: "pending-user-message",
        role: "user",
        parts: [{ type: "text", text: "deliver after handoff" }],
      },
      metadata: {},
    };

    try {
      await runInMockTaskContext(
        async (drivers) => {
          // This record is durable Session input, not run-local input. It is
          // written before the old run requests its handoff.
          await drivers.sessions.in.send(CHAT_ID, {
            kind: "message",
            payload: pendingPayload,
          });

          await expect(
            runFn(
              { chatId: CHAT_ID, trigger: "preload", metadata: {} },
              { ctx: drivers.ctx, signal: new AbortController().signal }
            )
          ).resolves.toBeUndefined();
        },
        {
          ctx: { run: { id: CALLING_RUN_ID } },
          sessionStreamManager: sessionStreams,
        }
      );

      expect(endAndContinueSession).toHaveBeenCalledWith(CHAT_ID, {
        callingRunId: CALLING_RUN_ID,
        reason: "upgrade",
      });

      await runInMockTaskContext(
        async (drivers) => {
          await expect(
            runFn(
              { chatId: CHAT_ID, continuation: true, metadata: {} },
              { ctx: drivers.ctx, signal: new AbortController().signal }
            )
          ).resolves.toBeUndefined();
        },
        {
          ctx: { run: { id: CONTINUATION_RUN_ID } },
          sessionStreamManager: sessionStreams,
        }
      );

      expect(continuationMessage).toEqual(pendingPayload.message);
    } finally {
      sessionStreams.dispose();
    }
  });

  it("rejects calls outside a custom agent run", async () => {
    const endAndContinueSession = vi.fn();
    vi.spyOn(apiClientManager, "clientOrThrow").mockReturnValue({
      endAndContinueSession,
    } as never);

    await runInMockTaskContext(async () => {
      await expect(chat.endAndContinue()).rejects.toThrow(
        "chat.endAndContinue() can only be called from inside a chat.customAgent() run"
      );
    });

    expect(endAndContinueSession).not.toHaveBeenCalled();
  });
});
