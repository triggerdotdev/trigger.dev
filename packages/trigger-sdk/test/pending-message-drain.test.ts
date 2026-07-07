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
  it("advances lastDispatchedSeqNum alongside lastSeqNum on waitpoint delivery", async () => {
    __setSessionOpenImplForTests(undefined);
    await runInMockTaskContext(async () => {
      vi.spyOn(apiClientManager, "clientOrThrow").mockReturnValue({
        createSessionStreamWaitpoint: async () => ({ waitpointId: "wp_test_1" }),
        waitForWaitpointToken: async () => ({ success: true }),
      } as never);

      const sessionId = "cursor-sess";
      // Simulate records 0..4 already received via SSE before the suspend.
      sessionStreams.setLastSeqNum(sessionId, "in", 4);

      const result = await sessions.open(sessionId).in.wait();

      expect(result.ok).toBe(true);
      expect(sessionStreams.lastSeqNum(sessionId, "in")).toBe(5);
      // The waitpoint-delivered record was consumed by this caller, so the
      // committed-consume cursor (what turn-completes persist as
      // `session-in-event-id`) must advance with it.
      expect(sessionStreams.lastDispatchedSeqNum(sessionId, "in")).toBe(5);
    });
  });
});
