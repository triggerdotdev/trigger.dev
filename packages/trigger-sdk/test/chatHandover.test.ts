// Import the test harness FIRST — installs the resource catalog so
// `chat.agent()` calls below register their task functions correctly.
import { mockChatAgent } from "../src/v3/test/index.js";

import { describe, expect, it, vi } from "vitest";
import { chat } from "../src/v3/ai.js";
import { simulateReadableStream, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { z } from "zod";

// ── Helpers ────────────────────────────────────────────────────────────

function textStream(text: string): ReadableStream<LanguageModelV3StreamPart> {
  return simulateReadableStream({
    chunks: [
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
    ],
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("chat.handover", () => {
  it("handover-skip (error path) exits cleanly without firing turn hooks", async () => {
    // `handover-skip` is now only sent when the customer's handler
    // ABORTS before producing a finishReason (dispatch error). The
    // agent run exits clean, no hooks fire. Normal pure-text and
    // tool-call finishes go through `kind: "handover"`.
    const onChatStart = vi.fn();
    const onTurnStart = vi.fn();
    const onTurnComplete = vi.fn();
    const onPreload = vi.fn();
    const runFn = vi.fn();

    const agent = chat.agent({
      id: "chat.handover.skip",
      onPreload,
      onChatStart,
      onTurnStart,
      onTurnComplete,
      run: async ({ messages, signal }) => {
        runFn();
        return streamText({
          model: new MockLanguageModelV3({
            doStream: async () => ({ stream: textStream("should-not-run") }),
          }),
          messages,
          abortSignal: signal,
        });
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "test-handover-skip",
      mode: "handover-prepare",
    });

    try {
      await harness.sendHandoverSkip();
      // Give any deferred work a tick.
      await new Promise((r) => setTimeout(r, 20));

      // No turn hooks fire on skip — the run boots, waits, and exits.
      expect(onPreload).not.toHaveBeenCalled();
      expect(onTurnStart).not.toHaveBeenCalled();
      expect(onTurnComplete).not.toHaveBeenCalled();
      expect(runFn).not.toHaveBeenCalled();

      // No content chunks were emitted — only the boot scaffolding (if any).
      expect(harness.allChunks).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("pure-text head-start (isFinal: true) runs full hook chain WITHOUT calling streamText", async () => {
    // Pure-text first turn: customer's step 1 produced the final
    // response. The agent runs onChatStart → onTurnStart →
    // onTurnComplete (so persistence works), but SKIPS the user's
    // run() callback entirely (no LLM call, no streamText).
    // onTurnComplete fires with the customer's partial as
    // `responseMessage`.
    const order: string[] = [];
    const runFn = vi.fn();

    let capturedResponse: { id?: string; partTypes?: string[]; firstText?: string } | undefined;

    const agent = chat.agent({
      id: "chat.handover.pure-text",
      onChatStart: () => { order.push("onChatStart"); },
      onTurnStart: () => { order.push("onTurnStart"); },
      onTurnComplete: ({ responseMessage }) => {
        order.push("onTurnComplete");
        capturedResponse = {
          id: responseMessage?.id,
          partTypes: (responseMessage?.parts ?? []).map((p) => p.type),
          firstText: (responseMessage?.parts ?? [])
            .filter((p) => p.type === "text")
            .map((p) => (p as { text?: string }).text || "")
            .join(""),
        };
      },
      run: async ({ messages, signal }) => {
        // Should NOT be called for isFinal: true.
        runFn();
        return streamText({
          model: new MockLanguageModelV3({
            doStream: async () => ({ stream: textStream("should-not-run") }),
          }),
          messages,
          abortSignal: signal,
        });
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "test-handover-final",
      mode: "handover-prepare",
    });

    try {
      await harness.sendHandover({
        partialAssistantMessage: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Hi there, hope you're well." }],
          },
        ],
        messageId: "asst-msg-1",
        isFinal: true,
      });
      // `onTurnComplete` fires AFTER the `trigger:turn-complete` chunk,
      // and the harness's `sendHandover` resolves on that chunk —
      // give onTurnComplete a tick to run.
      await new Promise((r) => setTimeout(r, 30));

      // All three hooks fired in order.
      expect(order).toEqual(["onChatStart", "onTurnStart", "onTurnComplete"]);
      // The user's run() was NEVER invoked — no LLM call from the agent.
      expect(runFn).not.toHaveBeenCalled();

      // onTurnComplete saw the customer's partial as responseMessage,
      // with the matching messageId for browser-side merging.
      expect(capturedResponse).toBeDefined();
      expect(capturedResponse!.id).toBe("asst-msg-1");
      expect(capturedResponse!.partTypes).toContain("text");
      expect(capturedResponse!.firstText).toBe("Hi there, hope you're well.");
    } finally {
      await harness.close();
    }
  });

  it("handover with schema-only pending tool-call resumes via approval-driven execution", async () => {
    // Customer-side tools are schema-only (no `execute` fn) — AI SDK
    // doesn't execute them, so `result.response.messages` after step 1
    // contains JUST the assistant message with the pending tool-call.
    // `chat-server.ts` reshapes this into AI SDK's tool-approval round
    // (assistant + tool-approval-request, tool with tool-approval-response)
    // before sending the handover signal. That's the wire shape this
    // test simulates.
    //
    // The agent ships the same tool — but with the heavy `execute` fn.
    // When the next `streamText` runs, AI SDK's initial-tool-execution
    // branch (stream-text.ts:1342-1486) sees the approval round, runs
    // the agent-side execute, and synthesizes a tool-result before the
    // step-2 LLM call.
    const toolExecute = vi.fn(async ({ city }: { city: string }) => ({
      city,
      temp: 22,
    }));

    const weatherTool = tool({
      description: "Look up weather",
      inputSchema: z.object({ city: z.string() }),
      execute: toolExecute,
    });

    const stepTwoStream = textStream("the weather in tokyo is 22°C");

    const agent = chat.agent({
      id: "chat.handover.schema-only-tool",
      run: async ({ messages, signal }) => {
        return streamText({
          model: new MockLanguageModelV3({
            doStream: async () => ({ stream: stepTwoStream }),
          }),
          messages,
          tools: { weather: weatherTool },
          abortSignal: signal,
        });
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "test-handover-schema-only",
      mode: "handover-prepare",
    });

    try {
      const turn = await harness.sendHandover({
        isFinal: false, // pending tool-call → agent runs streamText
        partialAssistantMessage: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "let me check the weather" },
              {
                type: "tool-call",
                toolCallId: "tc-1",
                toolName: "weather",
                input: { city: "tokyo" },
              },
              {
                type: "tool-approval-request",
                approvalId: "handover-approval-1",
                toolCallId: "tc-1",
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-approval-response",
                approvalId: "handover-approval-1",
                approved: true,
              },
            ],
          },
        ],
      });

      // The agent-side execute ran (this is the whole point of the
      // schema-only-on-customer pattern).
      expect(toolExecute).toHaveBeenCalledWith(
        expect.objectContaining({ city: "tokyo" }),
        expect.anything()
      );

      // Step-2 produced text was streamed through session.out.
      const text = turn.chunks
        .filter((c) => c.type === "text-delta")
        .map((c) => (c as { delta: string }).delta)
        .join("");
      expect(text).toContain("tokyo");
      expect(text).toContain("22°C");
    } finally {
      await harness.close();
    }
  });

  it("onTurnStart fires after the handover signal arrives (lazy)", async () => {
    // Hooks should not fire during the wait — only once handover lands
    // and a real turn begins. Verifies the order so customers can
    // mutate `chat.history` inside `onTurnStart` knowing the partial
    // assistant message is in scope.
    const events: string[] = [];

    const agent = chat.agent({
      id: "chat.handover.lazy-hooks",
      onPreload: () => {
        events.push("onPreload");
      },
      onChatStart: () => {
        events.push("onChatStart");
      },
      onTurnStart: () => {
        events.push("onTurnStart");
      },
      onTurnComplete: () => {
        events.push("onTurnComplete");
      },
      run: async ({ messages, signal }) => {
        events.push("run");
        return streamText({
          model: new MockLanguageModelV3({
            doStream: async () => ({ stream: textStream("ok") }),
          }),
          messages,
          abortSignal: signal,
        });
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "test-handover-lazy",
      mode: "handover-prepare",
    });

    try {
      // Before the signal lands, no hook should have fired.
      await new Promise((r) => setTimeout(r, 20));
      expect(events).toEqual([]);

      await harness.sendHandover({
        isFinal: false, // exercise the full streamText path
        partialAssistantMessage: [
          { role: "assistant", content: [{ type: "text", text: "warming up" }] },
        ],
      });
      // Let any deferred onTurnComplete fire.
      await new Promise((r) => setTimeout(r, 20));

      // onPreload never fires for handover-prepare. Everything else
      // fires once the partial lands — onChatStart still runs (first
      // turn invariant), then onTurnStart, run, onTurnComplete.
      expect(events).not.toContain("onPreload");
      expect(events).toContain("onChatStart");
      expect(events).toContain("onTurnStart");
      expect(events).toContain("run");
      expect(events).toContain("onTurnComplete");
      // Order: hooks before run, run before onTurnComplete.
      expect(events.indexOf("onTurnStart")).toBeLessThan(events.indexOf("run"));
      expect(events.indexOf("run")).toBeLessThan(events.indexOf("onTurnComplete"));
    } finally {
      await harness.close();
    }
  });

  it("idle timeout exits cleanly when no handover signal is sent", async () => {
    // Customer's POST handler crashed before signaling. The agent
    // should not hang forever — wait the configured idleTimeoutInSeconds
    // and exit, just like the handover-skip case.
    const onTurnStart = vi.fn();
    const onTurnComplete = vi.fn();

    const agent = chat.agent({
      id: "chat.handover.idle-timeout",
      idleTimeoutInSeconds: 1, // 1s — enough for the wait + exit.
      onTurnStart,
      onTurnComplete,
      run: async ({ messages, signal }) => {
        return streamText({
          model: new MockLanguageModelV3({
            doStream: async () => ({ stream: textStream("never") }),
          }),
          messages,
          abortSignal: signal,
        });
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "test-handover-timeout",
      mode: "handover-prepare",
    });

    try {
      // Wait long enough for the idle timeout to fire.
      await new Promise((r) => setTimeout(r, 1500));

      expect(onTurnStart).not.toHaveBeenCalled();
      expect(onTurnComplete).not.toHaveBeenCalled();
      expect(harness.allChunks).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });
});
