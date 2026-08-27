// Import the test harness FIRST — this installs the resource catalog so
// `chat.agent()` calls below register their task functions correctly.
import { mockChatAgent } from "../src/v3/test/index.js";

import { describe, expect, it, vi } from "vitest";
import { chat } from "../src/v3/ai.js";
import { __setSessionOpenImplForTests, sessions } from "../src/v3/sessions.js";
import { apiClientManager, sessionStreams } from "@trigger.dev/core/v3";
import { runInMockTaskContext } from "@trigger.dev/core/v3/test";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

// ── Helpers ────────────────────────────────────────────────────────────

function userMessage(text: string, id: string) {
  return {
    id,
    role: "user" as const,
    parts: [{ type: "text" as const, text }],
  };
}

function textStreamChunks(text: string): LanguageModelV3StreamPart[] {
  return [
    { type: "text-start", id: "t1" },
    { type: "text-delta", id: "t1", delta: text },
    { type: "text-end", id: "t1" },
    {
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 10, text: 10, reasoning: undefined },
      },
    },
  ];
}

/** Model that answers `ANSWER(<last user text>)`, slowly enough that
 * records sent right after the turn starts arrive mid-stream. */
function echoModel() {
  return new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const users = prompt.filter((m) => m.role === "user");
      const last = users[users.length - 1];
      const text = Array.isArray(last?.content)
        ? last.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("")
        : "";
      return {
        stream: simulateReadableStream({
          chunks: textStreamChunks(`ANSWER(${text})`),
          initialDelayInMs: 100,
          chunkDelayInMs: 10,
        }),
      };
    },
  });
}

async function waitFor(check: () => boolean, timeoutMs = 10_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

function runtimeWithWaitpointOutput(output: string, outputType = "application/json") {
  return {
    disable() {},
    waitForTask() {
      throw new Error("Unexpected task wait");
    },
    waitForBatch() {
      throw new Error("Unexpected batch wait");
    },
    waitForWaitpoint() {
      return Promise.resolve({ ok: true, output, outputType });
    },
  };
}

function streamedText(harness: { allChunks: unknown[] }): string {
  return (harness.allChunks as { type?: string; delta?: string }[])
    .filter((c) => c.type === "text-delta")
    .map((c) => c.delta ?? "")
    .join("");
}

function turnCompleteCount(harness: { allRawChunks: unknown[] }): number {
  return (harness.allRawChunks as { type?: string }[]).filter(
    (c) => c.type === "trigger:turn-complete"
  ).length;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("chat.agent pending wire buffer", () => {
  it("dispatches every message buffered during a turn, not just the first", async () => {
    const agent = chat.agent({
      id: "pending-drain.agent",
      run: async ({ messages, signal }) => {
        return streamText({ model: echoModel(), messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "pending-drain-1" });
    try {
      const first = harness.sendMessage(userMessage("m1", "u-1"));
      // Once m1's turn is streaming, land two more records back-to-back —
      // both are consumed into the turn's buffer before the turn ends.
      await waitFor(() => streamedText(harness).includes("ANSWER(m1)"));
      void harness.sendMessage(userMessage("m2", "u-2"));
      void harness.sendMessage(userMessage("m3", "u-3"));
      await first;

      await waitFor(() => turnCompleteCount(harness) >= 3);

      const text = streamedText(harness);
      const m2At = text.indexOf("ANSWER(m2)");
      const m3At = text.indexOf("ANSWER(m3)");
      expect(m2At).toBeGreaterThan(-1);
      expect(m3At).toBeGreaterThan(-1);
      expect(m3At).toBeGreaterThan(m2At);
    } finally {
      await harness.close();
    }
  });
});

describe("chat.agent steering config", () => {
  /**
   * `pendingMessages.onReceived` is the first thing a steering integration sees.
   * A message that lands mid-turn is delivered to the per-turn handler rather
   * than queued, so if that delivery breaks the symptom is a steer that appends
   * with a 2xx and is never seen by the agent, with nothing raised anywhere.
   *
   * Deliberately covers delivery only, NOT injection. Injection needs a
   * `prepareStep`, which arrives via `chat.toStreamTextOptions()`, and this run
   * body does not spread it; the mock model also answers in one step, so there
   * is no boundary to inject at. `onReceived` fires either way, so passing here
   * says nothing about whether a steer reaches the model. Do not read this as
   * "steering is covered".
   */
  it("fires onReceived for a message that lands mid-turn", async () => {
    const received: string[] = [];
    const injectDecisions: number[] = [];

    const agent = chat.agent({
      id: "pending-drain.steering",
      pendingMessages: {
        onReceived: ({ message }) => {
          received.push(message.id);
        },
        shouldInject: ({ steps }) => {
          injectDecisions.push(steps.length);
          return true;
        },
      },
      run: async ({ messages, signal }) => {
        return streamText({ model: echoModel(), messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "pending-drain-steer" });
    try {
      const first = harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(() => streamedText(harness).includes("ANSWER(m1)"));
      void harness.sendMessage(userMessage("steer me", "u-steer"));
      await first;

      await waitFor(() => received.length >= 1);
      expect(received).toContain("u-steer");
    } finally {
      await harness.close();
    }
  });
});

/**
 * A mid-turn message the agent declines to inject is documented to "queue for
 * the next turn". It used to be diverted into a turn-local steering queue and
 * discarded with the turn, so it was never injected, never written to the wire
 * buffer, and never answered, with nothing raised at either end. Declining is
 * also the default: with a `pendingMessages` config and no `shouldInject`, the
 * callback is treated as returning false for every batch.
 */
describe("chat.agent declined steering message", () => {
  it("answers a declined mid-turn message as its own turn", async () => {
    const received: string[] = [];

    const agent = chat.agent({
      id: "pending-drain.declined",
      pendingMessages: {
        onReceived: ({ message }) => {
          received.push(message.id);
        },
        shouldInject: () => false,
      },
      run: async ({ messages, signal }) => {
        return streamText({ model: echoModel(), messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "pending-drain-declined" });
    try {
      const first = harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(() => streamedText(harness).includes("ANSWER(m1)"));
      void harness.sendMessage(userMessage("m2", "u-2"));
      await first;

      await waitFor(() => turnCompleteCount(harness) >= 2);

      expect(received).toContain("u-2");
      expect(streamedText(harness)).toContain("ANSWER(m2)");
    } finally {
      await harness.close();
    }
  });
});

/**
 * The shape a developer reaches by following the docs for `onReceived` alone:
 * a `pendingMessages` config, no `shouldInject`, and no
 * `chat.toStreamTextOptions()` spread, so nothing can ever drain the steering
 * queue. The message must still be answered. It used to be taken off the
 * channel by the arrival handler and then stranded in a queue with no consumer.
 */
describe("chat.agent pendingMessages with nothing wired to drain it", () => {
  it("still answers a mid-turn message as its own turn", async () => {
    const received: string[] = [];

    const agent = chat.agent({
      id: "pending-drain.unwired",
      pendingMessages: {
        onReceived: ({ message }) => {
          received.push(message.id);
        },
      },
      run: async ({ messages, signal }) => {
        return streamText({ model: echoModel(), messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "pending-drain-unwired" });
    try {
      const first = harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(() => streamedText(harness).includes("ANSWER(m1)"));
      void harness.sendMessage(userMessage("m2", "u-2"));
      await first;

      await waitFor(() => turnCompleteCount(harness) >= 2);

      expect(received).toContain("u-2");
      expect(streamedText(harness)).toContain("ANSWER(m2)");
    } finally {
      await harness.close();
    }
  });
});

describe("chat.agent errored turn", () => {
  it(
    "does not duplicate messages buffered after a turn that threw",
    { timeout: 20000 },
    async () => {
      // Throw from a pre-stream hook: throws inside the streaming section are
      // already covered by its finally, but a hook throw used to leak the
      // turn's message handler into the loop-level buffer.
      let turnStarts = 0;
      const agent = chat.agent({
        id: "pending-drain.errored-turn",
        onTurnStart: async () => {
          turnStarts++;
          if (turnStarts === 1) {
            throw new Error("synthetic turn failure");
          }
        },
        run: async ({ messages, signal }) => {
          return streamText({ model: echoModel(), messages, abortSignal: signal });
        },
      });

      const harness = mockChatAgent(agent, { chatId: "pending-drain-4" });
      try {
        // Turn 1 throws — pre-fix its message handler leaked past the turn.
        await harness.sendMessage(userMessage("boom", "u-1"));
        const second = harness.sendMessage(userMessage("m2", "u-2"));
        // m3 lands mid-turn; a leaked handler would push it twice.
        await waitFor(() => streamedText(harness).includes("ANSWER(m2)"));
        void harness.sendMessage(userMessage("m3", "u-3"));
        await second;

        await waitFor(() => streamedText(harness).includes("ANSWER(m3)"));
        await new Promise((r) => setTimeout(r, 500));
        const text = streamedText(harness);
        expect(text.match(/ANSWER\(m3\)/g)).toHaveLength(1);
      } finally {
        await harness.close();
      }
    }
  );
});

describe("chat.createSession pending wire buffer", () => {
  it("dispatches messages buffered during a turn as subsequent turns", async () => {
    const agent = chat.customAgent({
      id: "pending-drain.session",
      run: async (payload) => {
        const session = chat.createSession(payload, {
          signal: new AbortController().signal,
          idleTimeoutInSeconds: 2,
        });
        for await (const turn of session) {
          const result = streamText({
            model: echoModel(),
            messages: turn.messages,
            abortSignal: turn.signal,
          });
          await turn.complete(result);
        }
      },
    });

    const harness = mockChatAgent(agent, { chatId: "pending-drain-2" });
    try {
      const first = harness.sendMessage(userMessage("m1", "u-1"));
      await waitFor(() => streamedText(harness).includes("ANSWER(m1)"));
      void harness.sendMessage(userMessage("m2", "u-2"));
      void harness.sendMessage(userMessage("m3", "u-3"));
      await first;

      await waitFor(() => turnCompleteCount(harness) >= 3);

      const text = streamedText(harness);
      expect(text).toContain("ANSWER(m2)");
      expect(text).toContain("ANSWER(m3)");
    } finally {
      await harness.close();
    }
  });
});

describe("chat.createSession stop + immediate send", () => {
  it(
    "dispatches a message that arrives right after a stopped turn",
    { timeout: 20000 },
    async () => {
      const agent = chat.customAgent({
        id: "pending-drain.session-stop",
        run: async (payload) => {
          const session = chat.createSession(payload, {
            signal: new AbortController().signal,
            idleTimeoutInSeconds: 2,
            // Steering config active — the failure mode routed post-stream
            // arrivals into the dead steering queue instead of the next turn.
            pendingMessages: {},
          });
          for await (const turn of session) {
            const result = streamText({
              model: echoModel(),
              messages: turn.messages,
              abortSignal: turn.signal,
            });
            await turn.complete(result);
          }
        },
      });

      const harness = mockChatAgent(agent, { chatId: "pending-drain-3" });
      try {
        const first = harness.sendMessage(userMessage("write a long essay", "u-1"));
        await waitFor(() => streamedText(harness).length > 0);
        await harness.sendStop();
        // Land the next message inside the stopped turn's post-stream window
        // (the ~2s totalUsage race), after the abort has settled — previously
        // the still-attached handler steering-routed it into the dead queue.
        await new Promise((r) => setTimeout(r, 150));
        void harness.sendMessage(userMessage("m2", "u-2"));
        await first;

        await waitFor(() => turnCompleteCount(harness) >= 2);
        await waitFor(() => streamedText(harness).includes("ANSWER(m2)"));
      } finally {
        await harness.close();
      }
    }
  );
});

describe("session.in.wait() consume cursor", () => {
  it("keeps later input reachable across the suspend-and-resume race", async () => {
    __setSessionOpenImplForTests(undefined);
    const first = { kind: "message", payload: { id: "u1" } };
    const later = { kind: "message", payload: { id: "u2" } };
    const runtimeManager = runtimeWithWaitpointOutput(JSON.stringify(first));
    let registeredLastSeqNum: number | undefined;

    await runInMockTaskContext(
      async (drivers) => {
        const sessionId = "cursor-sess";
        const channel = sessions.open(sessionId).in;
        const stop = channel.on<{ kind: string }>((record) => record.kind === "stop");

        sessionStreams.setLastSeqNum(sessionId, "in", 49);
        sessionStreams.setLastDispatchedSeqNum(sessionId, "in", 49);

        vi.spyOn(apiClientManager, "clientOrThrow").mockReturnValue({
          createSessionStreamWaitpoint: async (_runId: string, body: { lastSeqNum?: number }) => {
            registeredLastSeqNum = body.lastSeqNum;
            return {
              waitpointId: "wp_test_1",
              isCached: false,
            };
          },
          waitForWaitpointToken: async () => {
            // These records land after registration but before the tail is
            // disconnected. The waitpoint resolves with seq 50, while the
            // local tail has already consumed 51 and buffered 52.
            await drivers.sessions.in.send(sessionId, first, "in", { seqNum: 50 });
            await drivers.sessions.in.send(sessionId, { kind: "stop" }, "in", { seqNum: 51 });
            await drivers.sessions.in.send(sessionId, later, "in", { seqNum: 52 });
            return { success: true };
          },
        } as never);

        const result = await channel.wait();

        expect(result).toEqual({ ok: true, output: first });
        expect(registeredLastSeqNum).toBe(49);
        expect(sessionStreams.lastDispatchedSeqNum(sessionId, "in")).toBe(51);
        expect(sessionStreams.peekRecord(sessionId, "in")?.seqNum).toBe(52);

        const next = await sessionStreams.onceRecord(sessionId, "in");
        expect(next).toEqual({
          ok: true,
          output: { id: "test-record-52", seqNum: 52, data: later },
        });
        expect(sessionStreams.lastDispatchedSeqNum(sessionId, "in")).toBe(52);
        stop.off();
      },
      { runtimeManager }
    );
  });

  it("acknowledges the delivered record when identical payloads repeat on the channel", async () => {
    __setSessionOpenImplForTests(undefined);
    const chunk = { kind: "message", payload: { id: "repeated" } };
    const raw = JSON.stringify(chunk);
    const sessionId = "ack-repeated-payload";

    await runInMockTaskContext(
      async (drivers) => {
        sessionStreams.setLastSeqNum(sessionId, "in", 6);
        sessionStreams.setLastDispatchedSeqNum(sessionId, "in", 6);

        vi.spyOn(apiClientManager, "clientOrThrow").mockReturnValue({
          createSessionStreamWaitpoint: async () => ({
            waitpointId: "wp_ack_repeated",
            isCached: false,
          }),
          waitForWaitpointToken: async () => {
            await drivers.sessions.in.send(sessionId, chunk, "in", { seqNum: 7 });
            await drivers.sessions.in.send(sessionId, chunk, "in", { seqNum: 8 });
            return { success: true };
          },
          readSessionStreamRecords: async () => ({
            records: [
              { id: "repeated-1", seqNum: 7, data: raw },
              { id: "repeated-2", seqNum: 8, data: raw },
            ],
          }),
        } as never);

        const result = await sessions.open(sessionId).in.wait();
        expect(result).toEqual({ ok: true, output: chunk });

        expect(sessionStreams.lastDispatchedSeqNum(sessionId, "in")).toBe(7);
      },
      { runtimeManager: runtimeWithWaitpointOutput(raw) }
    );
  });
});
