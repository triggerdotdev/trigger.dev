// Import the test harness first so chat tasks register in its resource catalog.
import { mockChatAgent } from "../src/v3/test/index.js";

import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

function userMessage(text: string, id: string) {
  return {
    id,
    role: "user" as const,
    parts: [{ type: "text" as const, text }],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("waitFor timed out");
}

describe("chat.customAgent clientData validation", () => {
  it("passes parsed clientData to run and createSession turns", async () => {
    const clientData = { userId: "user_123", attempt: "42" };
    let initialClientData: unknown;
    let turnClientData: unknown;

    const agent = chat
      .withClientData({
        schema: z.object({
          userId: z.string(),
          attempt: z.coerce.number().int(),
        }),
      })
      .customAgent({
        id: "custom-agent-client-data-valid",
        run: async (payload, { signal }) => {
          expectTypeOf(payload.metadata).toEqualTypeOf<
            { userId: string; attempt: number } | undefined
          >();
          initialClientData = payload.metadata;

          const session = chat.createSession(payload, {
            signal,
            idleTimeoutInSeconds: 1,
          });
          for await (const turn of session) {
            expectTypeOf(turn.clientData).toEqualTypeOf<{
              userId: string;
              attempt: number;
            }>();
            turnClientData = turn.clientData;
            await turn.done();
            break;
          }
        },
      });

    const harness = mockChatAgent(agent, {
      chatId: "custom-agent-client-data-valid-chat",
      clientData,
    });

    try {
      await waitFor(() => initialClientData !== undefined);
      await harness.sendMessage(userMessage("hello", "message-1"));

      expect(initialClientData).toEqual({ userId: "user_123", attempt: 42 });
      expect(turnClientData).toEqual({ userId: "user_123", attempt: 42 });
    } finally {
      await harness.close();
    }
  });

  it("reports an invalid frame without passing it to the turn loop", async () => {
    const clientData: { userId: string; attempt: unknown } = {
      userId: "user_123",
      attempt: "1",
    };
    let started = false;
    const receivedClientData: unknown[] = [];
    const validationErrors: unknown[] = [];

    const agent = chat
      .withClientData({
        schema: z.object({
          userId: z.string(),
          attempt: z.coerce.number().int(),
        }),
      })
      .customAgent({
        id: "custom-agent-client-data-invalid-frame",
        onClientDataValidationError: ({ error }) => {
          validationErrors.push(error);
        },
        run: async (payload, { signal }) => {
          started = true;
          const session = chat.createSession(payload, {
            signal,
            idleTimeoutInSeconds: 1,
          });
          for await (const turn of session) {
            receivedClientData.push(turn.clientData);
            await turn.done();
          }
        },
      });

    const harness = mockChatAgent(agent, {
      chatId: "custom-agent-client-data-invalid-frame-chat",
      clientData,
    });

    try {
      await waitFor(() => started);
      clientData.attempt = "not-a-number";

      const invalidTurn = await harness.sendMessage(userMessage("invalid", "message-1"));

      expect(receivedClientData).toHaveLength(0);
      expect(invalidTurn.chunks).toEqual([
        expect.objectContaining({ type: "error", errorText: "Invalid client data" }),
      ]);
      expect(validationErrors).toHaveLength(1);
      expect(validationErrors[0]).toBeInstanceOf(z.ZodError);
      expect(invalidTurn.rawChunks).toContainEqual(
        expect.objectContaining({ type: "trigger:turn-complete" })
      );

      clientData.attempt = "2";
      await harness.sendMessage(userMessage("valid", "message-2"));
      await waitFor(() => receivedClientData.length === 1);

      expect(receivedClientData).toEqual([{ userId: "user_123", attempt: 2 }]);
    } finally {
      await harness.close();
    }
  });

  it("waits without completing a turn when a messageless continuation boot is invalid", async () => {
    let runCalls = 0;
    let receivedClientData: unknown;
    let receivedContinuation: boolean | undefined;
    let receivedPreviousRunId: string | undefined;
    const validationErrors: unknown[] = [];
    const clientData: { userId: unknown } = { userId: 123 };

    const agent = chat
      .withClientData({
        schema: z.object({ userId: z.string() }),
      })
      .customAgent({
        id: "custom-agent-client-data-invalid-initial",
        onClientDataValidationError: ({ error }) => {
          validationErrors.push(error);
        },
        run: async (payload) => {
          runCalls++;
          receivedClientData = payload.metadata;
          receivedContinuation = payload.continuation;
          receivedPreviousRunId = payload.previousRunId;
          await chat.writeTurnComplete();
        },
      });

    const harness = mockChatAgent(agent, {
      chatId: "custom-agent-client-data-invalid-initial-chat",
      clientData,
      continuation: true,
      previousRunId: "run_previous",
    });

    try {
      await waitFor(() => validationErrors.length === 1);

      expect(runCalls).toBe(0);
      expect(harness.allRawChunks).toHaveLength(0);

      clientData.userId = "user_123";
      const recovered = await harness.sendMessage(userMessage("retry", "message-1"));

      expect(runCalls).toBe(1);
      expect(receivedClientData).toEqual({ userId: "user_123" });
      expect(receivedContinuation).toBe(true);
      expect(receivedPreviousRunId).toBe("run_previous");
      expect(recovered.chunks).toHaveLength(0);
      expect(recovered.rawChunks).toEqual([
        expect.objectContaining({ type: "trigger:turn-complete" }),
      ]);
    } finally {
      await harness.close();
    }
  });

  it("completes an invalid submitted boot before waiting for valid clientData", async () => {
    const clientData: { userId: unknown } = { userId: 123 };
    let runCalls = 0;
    let receivedClientData: unknown;

    const agent = chat.withClientData({ schema: z.object({ userId: z.string() }) }).customAgent({
      id: "custom-agent-client-data-invalid-submitted-boot",
      run: async (payload) => {
        runCalls++;
        receivedClientData = payload.metadata;
        await chat.writeTurnComplete();
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "custom-agent-client-data-invalid-submitted-boot-chat",
      mode: "submit-message",
      clientData,
    });

    try {
      await waitFor(() =>
        harness.allRawChunks.some(
          (chunk) =>
            typeof chunk === "object" &&
            chunk !== null &&
            (chunk as { type?: string }).type === "trigger:turn-complete"
        )
      );

      expect(runCalls).toBe(0);
      expect(harness.allChunks).toEqual([
        expect.objectContaining({ type: "error", errorText: "Invalid client data" }),
      ]);

      clientData.userId = "user_123";
      await harness.sendMessage(userMessage("retry", "message-1"));

      expect(runCalls).toBe(1);
      expect(receivedClientData).toEqual({ userId: "user_123" });
    } finally {
      await harness.close();
    }
  });

  it("keeps async chat.messages.on deliveries in wire order", async () => {
    const clientData = { sequence: 0 };
    const parserStarts: number[] = [];
    const received: number[] = [];
    let started = false;
    const finished = deferred();

    const agent = chat
      .withClientData({
        schema: async (value: unknown) => {
          const sequence = (value as { sequence: number }).sequence;
          parserStarts.push(sequence);
          if (sequence === 1) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return { sequence };
        },
      })
      .customAgent({
        id: "custom-agent-client-data-async-order",
        run: async () => {
          started = true;
          const subscription = chat.messages.on(async (payload) => {
            received.push((payload.metadata as { sequence: number }).sequence);
            await chat.writeTurnComplete();
            if (received.length === 2) {
              finished.resolve();
            }
          });
          await finished.promise;
          subscription.off();
        },
      });

    const harness = mockChatAgent(agent, {
      chatId: "custom-agent-client-data-async-order-chat",
      clientData,
    });

    try {
      await waitFor(() => started);

      clientData.sequence = 1;
      const first = harness.sendMessage(userMessage("first", "message-1"));
      await waitFor(() => parserStarts.includes(1));

      clientData.sequence = 2;
      const second = harness.sendMessage(userMessage("second", "message-2"));

      await Promise.all([first, second]);
      await waitFor(() => received.length === 2);

      expect(received).toEqual([1, 2]);
    } finally {
      finished.resolve();
      await harness.close();
    }
  });

  it("does not report an invalid frame whose validation finishes after chat.messages.on is removed", async () => {
    const clientData = { blocked: false };
    const parserStarted = deferred();
    const releaseParser = deferred();
    const parserFinished = deferred();
    let removeSubscription: (() => void) | undefined;
    let handlerCalls = 0;
    let validationErrorCalls = 0;
    let started = false;

    const agent = chat
      .withClientData({
        schema: async (value: unknown) => {
          const blocked = (value as { blocked: boolean }).blocked;
          if (blocked) {
            parserStarted.resolve();
            await releaseParser.promise;
            parserFinished.resolve();
            throw new Error("invalid after unsubscribe");
          }
          return { blocked };
        },
      })
      .customAgent({
        id: "custom-agent-client-data-off-after-arrival",
        onClientDataValidationError: () => {
          validationErrorCalls++;
        },
        run: async (_payload, { signal }) => {
          started = true;
          const subscription = chat.messages.on(async () => {
            handlerCalls++;
          });
          removeSubscription = () => subscription.off();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      });

    const harness = mockChatAgent(agent, {
      chatId: "custom-agent-client-data-off-after-arrival-chat",
      clientData,
    });

    try {
      await waitFor(() => started);
      clientData.blocked = true;
      void harness.sendMessage(userMessage("hello", "message-1"));
      await parserStarted.promise;

      removeSubscription!();
      releaseParser.resolve();

      await parserFinished.promise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(handlerCalls).toBe(0);
      expect(validationErrorCalls).toBe(0);
    } finally {
      releaseParser.resolve();
      await harness.close();
    }
  });

  it("delivers a valid frame accepted before chat.messages.on is removed", async () => {
    const clientData = { blocked: false };
    const parserStarted = deferred();
    const releaseParser = deferred();
    const delivered = deferred();
    let removeSubscription: (() => void) | undefined;
    let receivedMetadata: unknown;
    let handlerCalls = 0;
    let started = false;

    const agent = chat
      .withClientData({
        schema: async (value: unknown) => {
          const blocked = (value as { blocked: boolean }).blocked;
          if (blocked) {
            parserStarted.resolve();
            await releaseParser.promise;
          }
          return { blocked, parsed: true as const };
        },
      })
      .customAgent({
        id: "custom-agent-client-data-deliver-pending-after-off",
        run: async (_payload, { signal }) => {
          started = true;
          const subscription = chat.messages.on(async (payload) => {
            handlerCalls++;
            receivedMetadata = payload.metadata;
            await chat.writeTurnComplete();
            delivered.resolve();
          });
          removeSubscription = () => subscription.off();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
      });

    const harness = mockChatAgent(agent, {
      chatId: "custom-agent-client-data-deliver-pending-after-off-chat",
      clientData,
    });

    try {
      await waitFor(() => started);
      clientData.blocked = true;
      const send = harness.sendMessage(userMessage("hello", "message-1"));
      await parserStarted.promise;

      removeSubscription!();
      releaseParser.resolve();

      await send;
      await delivered.promise;
      expect(handlerCalls).toBe(1);
      expect(receivedMetadata).toEqual({ blocked: true, parsed: true });
    } finally {
      releaseParser.resolve();
      await harness.close();
    }
  });

  it("throws from chat.messages.peek when an object parser returns a promise", async () => {
    const clientData = { userId: "user_123" };
    let started = false;
    let peekError: unknown;

    const agent = chat
      .withClientData({
        schema: {
          parse: async (value: unknown) => value as { userId: string },
        } as any,
      })
      .customAgent({
        id: "custom-agent-client-data-async-object-peek",
        run: async (_payload, { signal }) => {
          started = true;
          while (!signal.aborted) {
            try {
              chat.messages.peek();
            } catch (error) {
              peekError = error;
              await chat.writeTurnComplete();
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        },
      });

    const harness = mockChatAgent(agent, {
      chatId: "custom-agent-client-data-async-object-peek-chat",
      clientData,
    });

    try {
      await waitFor(() => started);
      const send = harness.sendMessage(userMessage("hello", "message-1"));
      await waitFor(() => peekError !== undefined);
      await send;

      expect(peekError).toBeInstanceOf(Error);
      expect((peekError as Error).message).toContain("asynchronous schema");
    } finally {
      await harness.close();
    }
  });

  it("does not complete an active turn when a buffered frame is invalid", async () => {
    const clientData: { attempt: unknown } = { attempt: "1" };
    const firstTurnStarted = deferred();
    const releaseFirstTurn = deferred();
    const validationErrors: unknown[] = [];
    const receivedClientData: unknown[] = [];
    let started = false;

    const agent = chat
      .withClientData({ schema: z.object({ attempt: z.coerce.number().int() }) })
      .customAgent({
        id: "custom-agent-client-data-buffered-invalid",
        onClientDataValidationError: ({ error }) => {
          validationErrors.push(error);
        },
        run: async (payload, { signal }) => {
          started = true;
          const session = chat.createSession(payload, {
            signal,
            idleTimeoutInSeconds: 1,
          });
          for await (const turn of session) {
            receivedClientData.push(turn.clientData);
            firstTurnStarted.resolve();
            await releaseFirstTurn.promise;
            await turn.done();
          }
        },
      });

    const harness = mockChatAgent(agent, {
      chatId: "custom-agent-client-data-buffered-invalid-chat",
      clientData,
    });

    try {
      await waitFor(() => started);
      const first = harness.sendMessage(userMessage("first", "message-1"));
      await firstTurnStarted.promise;

      clientData.attempt = "not-a-number";
      const invalid = harness.sendMessage(userMessage("invalid", "message-2"));
      await new Promise((resolve) => setTimeout(resolve, 75));

      expect(validationErrors).toHaveLength(0);
      expect(harness.allRawChunks).toHaveLength(0);

      releaseFirstTurn.resolve();
      await Promise.all([first, invalid]);
      await waitFor(() => validationErrors.length === 1);

      expect(receivedClientData).toEqual([{ attempt: 1 }]);
      expect(harness.allChunks).toContainEqual(
        expect.objectContaining({ type: "error", errorText: "Invalid client data" })
      );
    } finally {
      releaseFirstTurn.resolve();
      await harness.close();
    }
  });

  it("buffers a steering frame whose validation finishes after the turn closes", async () => {
    const clientData = { sequence: 0 };
    const parserStarted = deferred();
    const releaseParser = deferred();
    const firstTurnStarted = deferred();
    const releaseFirstTurn = deferred();
    const firstDoneStarted = deferred();
    const secondTurnFinished = deferred();
    const receivedSequences: number[] = [];
    const receivedMessageIds: string[][] = [];
    let started = false;

    const agent = chat
      .withClientData({
        schema: async (value: unknown) => {
          const sequence = (value as { sequence: number }).sequence;
          if (sequence === 2) {
            parserStarted.resolve();
            await releaseParser.promise;
          }
          return { sequence };
        },
      })
      .customAgent({
        id: "custom-agent-client-data-late-steering-validation",
        run: async (payload, { signal }) => {
          started = true;
          const session = chat.createSession(payload, {
            signal,
            idleTimeoutInSeconds: 1,
            pendingMessages: {},
          });
          for await (const turn of session) {
            receivedSequences.push(turn.clientData.sequence);
            receivedMessageIds.push(turn.uiMessages.map((message) => message.id));
            if (turn.number === 0) {
              firstTurnStarted.resolve();
              await releaseFirstTurn.promise;
              firstDoneStarted.resolve();
              await turn.done();
              continue;
            }
            await turn.done();
            secondTurnFinished.resolve();
            break;
          }
        },
      });

    const harness = mockChatAgent(agent, {
      chatId: "custom-agent-client-data-late-steering-validation-chat",
      clientData,
    });

    try {
      await waitFor(() => started);
      clientData.sequence = 1;
      const first = harness.sendMessage(userMessage("first", "message-1"));
      await firstTurnStarted.promise;

      clientData.sequence = 2;
      void harness.sendMessage(userMessage("second", "message-2"));
      await parserStarted.promise;

      releaseFirstTurn.resolve();
      await firstDoneStarted.promise;
      await Promise.resolve();
      releaseParser.resolve();

      await first;
      await secondTurnFinished.promise;
      expect(receivedSequences).toEqual([1, 2]);
      expect(receivedMessageIds).toEqual([["message-1"], ["message-1", "message-2"]]);
    } finally {
      releaseFirstTurn.resolve();
      releaseParser.resolve();
      await harness.close();
    }
  });

  it("does not reparse an invalid steering frame after the turn closes", async () => {
    const clientData = { sequence: 0 };
    const parserStarted = deferred();
    const releaseParser = deferred();
    const firstTurnStarted = deferred();
    const releaseFirstTurn = deferred();
    const firstDoneStarted = deferred();
    const validationErrors: unknown[] = [];
    const receivedSequences: number[] = [];
    let lateFrameParseCalls = 0;
    let started = false;

    const agent = chat
      .withClientData({
        schema: async (value: unknown) => {
          const sequence = (value as { sequence: number }).sequence;
          if (sequence === 2) {
            lateFrameParseCalls++;
            parserStarted.resolve();
            await releaseParser.promise;
            if (lateFrameParseCalls === 1) {
              throw new Error("invalid late frame");
            }
          }
          return { sequence };
        },
      })
      .customAgent({
        id: "custom-agent-client-data-late-invalid-steering",
        onClientDataValidationError: ({ error }) => {
          validationErrors.push(error);
        },
        run: async (payload, { signal }) => {
          started = true;
          const session = chat.createSession(payload, {
            signal,
            idleTimeoutInSeconds: 1,
            pendingMessages: {},
          });
          for await (const turn of session) {
            receivedSequences.push(turn.clientData.sequence);
            firstTurnStarted.resolve();
            await releaseFirstTurn.promise;
            firstDoneStarted.resolve();
            await turn.done();
          }
        },
      });

    const harness = mockChatAgent(agent, {
      chatId: "custom-agent-client-data-late-invalid-steering-chat",
      clientData,
    });

    try {
      await waitFor(() => started);
      clientData.sequence = 1;
      const first = harness.sendMessage(userMessage("first", "message-1"));
      await firstTurnStarted.promise;

      clientData.sequence = 2;
      void harness.sendMessage(userMessage("second", "message-2"));
      await parserStarted.promise;

      releaseFirstTurn.resolve();
      await firstDoneStarted.promise;
      await Promise.resolve();
      releaseParser.resolve();

      await first;
      await waitFor(() => validationErrors.length === 1);
      expect(lateFrameParseCalls).toBe(1);
      expect(receivedSequences).toEqual([1]);
      expect(harness.allChunks).toContainEqual(
        expect.objectContaining({ type: "error", errorText: "Invalid client data" })
      );
    } finally {
      releaseFirstTurn.resolve();
      releaseParser.resolve();
      await harness.close();
    }
  });

  it("reports invalid chat.messages.on frames without calling the subscriber", async () => {
    const clientData: { userId: unknown } = { userId: "user_123" };
    const validationErrors: unknown[] = [];
    let handlerCalls = 0;
    let started = false;

    const agent = chat.withClientData({ schema: z.object({ userId: z.string() }) }).customAgent({
      id: "custom-agent-client-data-on-invalid",
      onClientDataValidationError: ({ error }) => {
        validationErrors.push(error);
      },
      run: async (_payload, { signal }) => {
        started = true;
        const subscription = chat.messages.on(() => {
          handlerCalls++;
        });
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        subscription.off();
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "custom-agent-client-data-on-invalid-chat",
      clientData,
    });

    try {
      await waitFor(() => started);
      clientData.userId = 123;
      void harness.sendMessage(userMessage("invalid", "message-1"));
      await waitFor(() => validationErrors.length === 1);

      expect(handlerCalls).toBe(0);
      expect(harness.allRawChunks).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("exits without a turn when a handover-prepare boot has invalid clientData and the warm handler skips", async () => {
    const clientData: { userId: unknown } = { userId: 123 };
    const validationErrors: unknown[] = [];
    let runCalls = 0;

    const agent = chat.withClientData({ schema: z.object({ userId: z.string() }) }).customAgent({
      id: "custom-agent-client-data-handover-skip",
      onClientDataValidationError: ({ error }) => {
        validationErrors.push(error);
      },
      run: async () => {
        runCalls++;
        await chat.writeTurnComplete();
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "custom-agent-client-data-handover-skip-chat",
      mode: "handover-prepare",
      clientData,
    });

    try {
      await waitFor(() => validationErrors.length === 1);
      expect(runCalls).toBe(0);
      expect(harness.allRawChunks).toHaveLength(0);

      // The validation path must drain the skip via the handover facade and
      // end the run, mirroring the normal handover-skip exit.
      await harness.sendHandoverSkip();

      // The run has exited — a valid frame must NOT boot the loop. (Without
      // the drain, the run would still be sitting in the message wait and
      // would process it.) Fire-and-forget: no turn-complete will arrive.
      clientData.userId = "user_123";
      void harness.sendMessage(userMessage("late", "message-1")).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(runCalls).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("fails an invalid handover boot after the warm handler signals", async () => {
    const clientData: { userId: unknown } = { userId: 123 };
    const validationErrors: unknown[] = [];
    let runCalls = 0;

    const agent = chat.withClientData({ schema: z.object({ userId: z.string() }) }).customAgent({
      id: "custom-agent-client-data-handover-invalid",
      onClientDataValidationError: ({ error }) => {
        validationErrors.push(error);
      },
      run: async () => {
        runCalls++;
        await chat.writeTurnComplete();
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "custom-agent-client-data-handover-invalid-chat",
      mode: "handover-prepare",
      clientData,
    });

    try {
      await waitFor(() => validationErrors.length === 1);
      expect(runCalls).toBe(0);
      expect(harness.allRawChunks).toHaveLength(0);

      const handover = await harness.sendHandover({
        partialAssistantMessage: [
          { role: "assistant", content: [{ type: "text", text: "warm partial" }] },
        ],
      });

      expect(runCalls).toBe(0);
      expect(handover.chunks).toEqual([
        expect.objectContaining({ type: "error", errorText: "Invalid client data" }),
      ]);
      expect(handover.rawChunks).toContainEqual(
        expect.objectContaining({ type: "trigger:turn-complete" })
      );
    } finally {
      await harness.close();
    }
  });

  it("passes clientData through unchanged when no schema is configured", async () => {
    const clientData = { userId: "user_123", nested: { enabled: true } };
    let initialClientData: unknown;
    let turnClientData: unknown;

    const agent = chat.customAgent({
      id: "custom-agent-client-data-no-schema",
      run: async (payload, { signal }) => {
        initialClientData = payload.metadata;
        const session = chat.createSession(payload, {
          signal,
          idleTimeoutInSeconds: 1,
        });
        for await (const turn of session) {
          turnClientData = turn.clientData;
          await turn.done();
          break;
        }
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "custom-agent-client-data-no-schema-chat",
      clientData,
    });

    try {
      await waitFor(() => initialClientData !== undefined);
      await harness.sendMessage(userMessage("hello", "message-1"));

      expect(initialClientData).toBe(clientData);
      expect(turnClientData).toBe(clientData);
    } finally {
      await harness.close();
    }
  });
});
