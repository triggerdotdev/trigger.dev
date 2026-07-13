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
      onChatStart: () => {
        order.push("onChatStart");
      },
      onTurnStart: () => {
        order.push("onTurnStart");
      },
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

  it("pure-text head-start preserves reasoning parts in the response (TRI-10716)", async () => {
    // Extended-thinking models stream a reasoning part in step 1. The
    // synthesized partial must carry it (with provider metadata, so an
    // Anthropic signature survives a UIMessage -> ModelMessage round
    // trip) or the durable history loses the step-1 thinking.
    let captured: { partTypes?: string[]; reasoningText?: string; meta?: unknown } | undefined;

    const agent = chat.agent({
      id: "chat.handover.reasoning",
      onTurnComplete: ({ responseMessage }) => {
        const parts = responseMessage?.parts ?? [];
        captured = {
          partTypes: parts.map((p) => p.type),
          reasoningText: parts
            .filter((p) => p.type === "reasoning")
            .map((p) => (p as { text?: string }).text || "")
            .join(""),
          meta: (
            parts.find((p) => p.type === "reasoning") as { providerMetadata?: unknown } | undefined
          )?.providerMetadata,
        };
      },
      run: async ({ messages, signal }) => {
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
      chatId: "test-handover-reasoning",
      mode: "handover-prepare",
    });

    try {
      await harness.sendHandover({
        partialAssistantMessage: [
          {
            role: "assistant",
            content: [
              {
                type: "reasoning",
                text: "thinking about the greeting",
                providerOptions: { anthropic: { signature: "sig-abc" } },
              },
              { type: "text", text: "Hello!" },
            ],
          },
        ],
        messageId: "asst-reason-1",
        isFinal: true,
      });
      await new Promise((r) => setTimeout(r, 30));

      expect(captured).toBeDefined();
      expect(captured!.partTypes).toEqual(["reasoning", "text"]);
      expect(captured!.reasoningText).toBe("thinking about the greeting");
      expect(captured!.meta).toEqual({ anthropic: { signature: "sig-abc" } });
    } finally {
      await harness.close();
    }
  });

  it("pure-text head-start (isFinal: true) with hydrateMessages persists the partial (TRI-10715)", async () => {
    // Same as the pure-text case above, but the customer registers
    // `hydrateMessages` (the documented DB-as-source-of-truth pattern).
    // The head-start user message must reach the hydrate hook as
    // `incomingMessages`, and the warm route's partial must land in the
    // accumulator so `onTurnComplete` carries the full first turn.
    const runFn = vi.fn();
    const stored: { id: string; role: string; parts: unknown[] }[] = [];
    const hydrateIncomingRoles: string[] = [];
    let captured: { responseId?: string; responseText?: string; roles?: string[] } | undefined;

    const agent = chat.agent({
      id: "chat.handover.hydrate-pure-text",
      hydrateMessages: async ({ incomingMessages }) => {
        hydrateIncomingRoles.push(...incomingMessages.map((m) => m.role));
        for (const m of incomingMessages) {
          if (!stored.some((s) => s.id === m.id)) stored.push(m as (typeof stored)[number]);
        }
        return [...stored] as never;
      },
      onTurnComplete: ({ responseMessage, uiMessages }) => {
        captured = {
          responseId: responseMessage?.id,
          responseText: (responseMessage?.parts ?? [])
            .filter((p) => p.type === "text")
            .map((p) => (p as { text?: string }).text || "")
            .join(""),
          roles: uiMessages.map((m) => m.role),
        };
      },
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
      chatId: "test-handover-hydrate-final",
      mode: "handover-prepare",
      headStartMessages: [
        { id: "hs-user-1", role: "user", parts: [{ type: "text", text: "say hi" }] },
      ],
    });

    try {
      await harness.sendHandover({
        partialAssistantMessage: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Hi there, hope you're well." }],
          },
        ],
        messageId: "asst-hydrate-1",
        isFinal: true,
      });
      await new Promise((r) => setTimeout(r, 30));

      // isFinal — the agent never calls the user's run().
      expect(runFn).not.toHaveBeenCalled();

      // The head-start user message reached the hydrate hook as incoming.
      expect(hydrateIncomingRoles).toContain("user");

      // onTurnComplete carries the full first turn: user + the warm
      // route's assistant, under the handover messageId.
      expect(captured).toBeDefined();
      expect(captured!.roles).toEqual(["user", "assistant"]);
      expect(captured!.responseId).toBe("asst-hydrate-1");
      expect(captured!.responseText).toBe("Hi there, hope you're well.");
    } finally {
      await harness.close();
    }
  });

  it("tool-call handover (isFinal: false) with hydrateMessages resumes from step 2 (TRI-10715)", async () => {
    // Hydrate variant of the schema-only tool-call case: the spliced
    // partial (assistant + approval round) must reach the agent's
    // streamText so AI SDK executes the pending tool instead of
    // re-running step 1 from scratch against an empty/short prompt.
    const toolExecute = vi.fn(async ({ city }: { city: string }) => ({ city, temp: 22 }));
    const weatherTool = tool({
      description: "Look up weather",
      inputSchema: z.object({ city: z.string() }),
      execute: toolExecute,
    });

    const stored: { id: string; role: string; parts: unknown[] }[] = [];
    let runMessageRoles: string[] | undefined;
    let captured: { roles?: string[]; assistantIds?: (string | undefined)[] } | undefined;

    const agent = chat.agent({
      id: "chat.handover.hydrate-schema-only-tool",
      hydrateMessages: async ({ incomingMessages }) => {
        for (const m of incomingMessages) {
          if (!stored.some((s) => s.id === m.id)) stored.push(m as (typeof stored)[number]);
        }
        return [...stored] as never;
      },
      onTurnComplete: ({ uiMessages }) => {
        captured = {
          roles: uiMessages.map((m) => m.role),
          assistantIds: uiMessages.filter((m) => m.role === "assistant").map((m) => m.id),
        };
      },
      run: async ({ messages, signal }) => {
        runMessageRoles = messages.map((m) => m.role);
        return streamText({
          model: new MockLanguageModelV3({
            doStream: async () => ({ stream: textStream("the weather in tokyo is 22°C") }),
          }),
          messages,
          tools: { weather: weatherTool },
          abortSignal: signal,
        });
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "test-handover-hydrate-tool",
      mode: "handover-prepare",
      headStartMessages: [
        { id: "hs-user-2", role: "user", parts: [{ type: "text", text: "weather in tokyo?" }] },
      ],
    });

    try {
      const turn = await harness.sendHandover({
        isFinal: false,
        messageId: "asst-hydrate-2",
        partialAssistantMessage: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "let me check the weather" },
              {
                type: "tool-call",
                toolCallId: "tc-h1",
                toolName: "weather",
                input: { city: "tokyo" },
              },
              {
                type: "tool-approval-request",
                approvalId: "handover-approval-h1",
                toolCallId: "tc-h1",
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-approval-response",
                approvalId: "handover-approval-h1",
                approved: true,
              },
            ],
          },
        ],
      });
      await new Promise((r) => setTimeout(r, 30));

      // The resume prompt contained the full splice: user + partial
      // assistant + approval round — NOT an empty/user-only prompt.
      expect(runMessageRoles).toEqual(["user", "assistant", "tool"]);

      // AI SDK's initial-tool-execution branch ran the agent-side
      // execute (no step-1 re-run).
      expect(toolExecute).toHaveBeenCalledWith(
        expect.objectContaining({ city: "tokyo" }),
        expect.anything()
      );

      // Step-2 text streamed through session.out.
      const text = turn.chunks
        .filter((c) => c.type === "text-delta")
        .map((c) => (c as { delta: string }).delta)
        .join("");
      expect(text).toContain("tokyo");

      // One assistant in the final chain, under the handover messageId.
      expect(captured).toBeDefined();
      expect(captured!.roles).toEqual(["user", "assistant"]);
      expect(captured!.assistantIds).toEqual(["asst-hydrate-2"]);
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
