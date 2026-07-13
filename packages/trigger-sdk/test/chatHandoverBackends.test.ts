// Import the test harness FIRST — installs the resource catalog so the
// chat task functions below register correctly.
import { mockChatAgent } from "../src/v3/test/index.js";

import { describe, expect, it, vi } from "vitest";
import { chat } from "../src/v3/ai.js";
import { simulateReadableStream, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { ModelMessage, UIMessage } from "ai";
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

type Capture = {
  skipped?: boolean;
  isFinal?: boolean;
  handover?: { isFinal: boolean } | null;
  uiMessages?: Array<{ id: string; role: string; partTypes: string[] }>;
};

function snapshot(uiMessages: UIMessage[]): Capture["uiMessages"] {
  return uiMessages.map((m) => ({
    id: m.id,
    role: m.role,
    partTypes: (m.parts ?? []).map((p) => p.type),
  }));
}

// A pure-text partial (the warm step-1 response, isFinal: true).
const PURE_TEXT_PARTIAL: ModelMessage[] = [
  { role: "assistant", content: [{ type: "text", text: "Hi there, hope you're well." }] },
];

// A tool-call partial reshaped server-side into the approval round (isFinal: false).
const TOOL_CALL_PARTIAL: ModelMessage[] = [
  {
    role: "assistant",
    content: [
      { type: "text", text: "let me check the weather" },
      { type: "tool-call", toolCallId: "tc-1", toolName: "weather", input: { city: "tokyo" } },
      {
        type: "tool-approval-request",
        approvalId: "handover-approval-1",
        toolCallId: "tc-1",
      } as never,
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-approval-response",
        approvalId: "handover-approval-1",
        approved: true,
      } as never,
    ],
  },
];

function weatherToolWithExecute(execute: (input: { city: string }) => Promise<unknown>) {
  return tool({
    description: "Look up weather",
    inputSchema: z.object({ city: z.string() }),
    execute: execute as never,
  });
}

// ── chat.customAgent + headStart handover ───────────────────────────────

describe("chat.customAgent + headStart handover", () => {
  it("consumeHandover skip → clean exit, no turn-complete", async () => {
    const capture: Capture = {};
    const runAfter = vi.fn();

    const agent = chat.customAgent({
      id: "custom.handover.skip",
      run: async (payload) => {
        const conversation = new chat.MessageAccumulator();
        const { isFinal, skipped } = await conversation.consumeHandover({ payload });
        capture.skipped = skipped;
        capture.isFinal = isFinal;
        if (skipped) return;
        runAfter();
        await chat.writeTurnComplete();
      },
    });

    const harness = mockChatAgent(agent, { chatId: "t-skip", mode: "handover-prepare" });
    try {
      await harness.sendHandoverSkip();
      await new Promise((r) => setTimeout(r, 20));
      expect(capture.skipped).toBe(true);
      expect(capture.isFinal).toBe(false);
      expect(runAfter).not.toHaveBeenCalled();
      expect(harness.allChunks).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("consumeHandover isFinal: true (pure text) → partial spliced, no streamText", async () => {
    const capture: Capture = {};
    const runAfter = vi.fn();

    const agent = chat.customAgent({
      id: "custom.handover.final",
      run: async (payload) => {
        const conversation = new chat.MessageAccumulator();
        const { isFinal, skipped } = await conversation.consumeHandover({ payload });
        capture.skipped = skipped;
        capture.isFinal = isFinal;
        capture.uiMessages = snapshot(conversation.uiMessages);
        if (skipped) return;
        if (isFinal) {
          await chat.writeTurnComplete();
          return;
        }
        runAfter();
      },
    });

    const harness = mockChatAgent(agent, { chatId: "t-final", mode: "handover-prepare" });
    try {
      await harness.sendHandover({
        partialAssistantMessage: PURE_TEXT_PARTIAL,
        messageId: "asst-msg-1",
        isFinal: true,
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(capture.skipped).toBe(false);
      expect(capture.isFinal).toBe(true);
      // The warm step-1 partial is in the accumulator under its messageId.
      expect(capture.uiMessages).toEqual([
        { id: "asst-msg-1", role: "assistant", partTypes: ["text"] },
      ]);
      // isFinal means no streamText.
      expect(runAfter).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("consumeHandover isFinal: false (tool call) → streamText runs the handed-over tool round", async () => {
    const capture: Capture = {};
    const toolExecute = vi.fn(async ({ city }: { city: string }) => ({ city, temp: 22 }));

    const agent = chat.customAgent({
      id: "custom.handover.toolcall",
      run: async (payload) => {
        const conversation = new chat.MessageAccumulator();
        const { isFinal, skipped } = await conversation.consumeHandover({ payload });
        capture.skipped = skipped;
        capture.isFinal = isFinal;
        if (skipped) return;
        if (isFinal) {
          await chat.writeTurnComplete();
          return;
        }
        const result = streamText({
          model: new MockLanguageModelV3({
            doStream: async () => ({ stream: textStream("the weather in tokyo is 22°C") }),
          }),
          messages: conversation.modelMessages,
          tools: { weather: weatherToolWithExecute(toolExecute) },
        });
        await chat.pipeAndCapture(result);
        await chat.writeTurnComplete();
      },
    });

    const harness = mockChatAgent(agent, { chatId: "t-tool", mode: "handover-prepare" });
    try {
      await harness.sendHandover({
        partialAssistantMessage: TOOL_CALL_PARTIAL,
        messageId: "asst-msg-2",
        isFinal: false,
      });
      // Handover consumed as non-final, and the handed-over tool round resumed:
      // the agent-side `execute` ran on the pending tool-call from step 1
      // (schema-only-on-warm-handler pattern). The full step-2-text-through-handover
      // path is verified end-to-end by the ai-chat-e2e smoke test (T29).
      expect(capture.isFinal).toBe(false);
      expect(toolExecute).toHaveBeenCalledWith(
        expect.objectContaining({ city: "tokyo" }),
        expect.anything()
      );
    } finally {
      await harness.close();
    }
  });

  it("addResponse replaces the spliced partial in place when the resume reuses its id", async () => {
    // On a non-final handover resume the pipe threads originalMessages, so the
    // captured response carries the SAME id as the spliced partial. addResponse
    // must replace it, not append a duplicate (else the persisted accumulator
    // ends up with two assistant messages — caught live by T29, not the mock pipe).
    const capture: Capture = {};

    const agent = chat.customAgent({
      id: "custom.handover.addresponse-dedup",
      run: async (payload) => {
        const conversation = new chat.MessageAccumulator();
        await conversation.consumeHandover({ payload });
        // Simulate the merged step-2 response reusing the partial's id.
        await conversation.addResponse({
          id: "asst-msg-2",
          role: "assistant",
          parts: [
            { type: "text", text: "the weather in tokyo is 22°C" },
            {
              type: "tool-weather",
              toolCallId: "tc-1",
              state: "output-available",
              input: { city: "tokyo" },
              output: { city: "tokyo", temp: 22 },
            } as never,
          ],
        });
        capture.uiMessages = snapshot(conversation.uiMessages);
        await chat.writeTurnComplete();
      },
    });

    const harness = mockChatAgent(agent, { chatId: "t-addresp-dedup", mode: "handover-prepare" });
    try {
      await harness.sendHandover({
        partialAssistantMessage: TOOL_CALL_PARTIAL,
        messageId: "asst-msg-2",
        isFinal: false,
      });
      await new Promise((r) => setTimeout(r, 20));
      // Exactly one assistant message under the handover id — replaced, not doubled.
      expect(capture.uiMessages!.filter((m) => m.id === "asst-msg-2")).toHaveLength(1);
      expect(capture.uiMessages!.filter((m) => m.role === "assistant")).toHaveLength(1);
      // And it carries the merged step-2 content (text + resolved tool output).
      expect(capture.uiMessages!.at(-1)?.partTypes).toEqual(["text", "tool-weather"]);
    } finally {
      await harness.close();
    }
  });

  it("seeds payload.headStartMessages before splicing the partial", async () => {
    const capture: Capture = {};
    const prior: UIMessage[] = [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
    ];

    const agent = chat.customAgent({
      id: "custom.handover.seed",
      run: async (payload) => {
        const conversation = new chat.MessageAccumulator();
        await conversation.consumeHandover({ payload });
        capture.uiMessages = snapshot(conversation.uiMessages);
        await chat.writeTurnComplete();
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "t-seed",
      mode: "handover-prepare",
      headStartMessages: prior,
    });
    try {
      await harness.sendHandover({
        partialAssistantMessage: PURE_TEXT_PARTIAL,
        messageId: "asst-msg-3",
        isFinal: true,
      });
      await new Promise((r) => setTimeout(r, 20));
      // Prior history first, then the warm partial.
      expect(capture.uiMessages).toEqual([
        { id: "u-1", role: "user", partTypes: ["text"] },
        { id: "asst-msg-3", role: "assistant", partTypes: ["text"] },
      ]);
    } finally {
      await harness.close();
    }
  });

  it("dedups the partial when headStartMessages already carries its messageId", async () => {
    const capture: Capture = {};
    const prior: UIMessage[] = [
      { id: "u-1", role: "user", parts: [{ type: "text", text: "hello" }] },
      // Already-persisted partial under the same id the handover uses.
      {
        id: "asst-dup",
        role: "assistant",
        parts: [{ type: "text", text: "Hi there, hope you're well." }],
      },
    ];

    const agent = chat.customAgent({
      id: "custom.handover.dedup",
      run: async (payload) => {
        const conversation = new chat.MessageAccumulator();
        await conversation.consumeHandover({ payload });
        capture.uiMessages = snapshot(conversation.uiMessages);
        await chat.writeTurnComplete();
      },
    });

    const harness = mockChatAgent(agent, {
      chatId: "t-dedup",
      mode: "handover-prepare",
      headStartMessages: prior,
    });
    try {
      await harness.sendHandover({
        partialAssistantMessage: PURE_TEXT_PARTIAL,
        messageId: "asst-dup",
        isFinal: true,
      });
      await new Promise((r) => setTimeout(r, 20));
      // Not doubled — still just the two seeded messages.
      expect(capture.uiMessages).toHaveLength(2);
      expect(capture.uiMessages!.filter((m) => m.id === "asst-dup")).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});

// ── chat.createSession + headStart handover ──────────────────────────────

describe("chat.createSession + headStart handover", () => {
  it("turn.handover.isFinal: true → complete() with no source finalizes the partial", async () => {
    const capture: Capture = {};
    const runAfter = vi.fn();

    const agent = chat.customAgent({
      id: "session.handover.final",
      run: async (payload) => {
        const session = chat.createSession(payload, { signal: new AbortController().signal });
        for await (const turn of session) {
          capture.handover = turn.handover;
          capture.uiMessages = snapshot(turn.uiMessages);
          if (turn.handover?.isFinal) {
            await turn.complete();
            return;
          }
          runAfter();
          return;
        }
      },
    });

    const harness = mockChatAgent(agent, { chatId: "s-final", mode: "handover-prepare" });
    try {
      await harness.sendHandover({
        partialAssistantMessage: PURE_TEXT_PARTIAL,
        messageId: "asst-msg-4",
        isFinal: true,
      });
      await new Promise((r) => setTimeout(r, 20));
      expect(capture.handover).toEqual({ isFinal: true });
      expect(capture.uiMessages).toEqual([
        { id: "asst-msg-4", role: "assistant", partTypes: ["text"] },
      ]);
      expect(runAfter).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it("turn.handover.isFinal: false → streamText runs the handed-over tool round", async () => {
    const capture: Capture = {};
    const toolExecute = vi.fn(async ({ city }: { city: string }) => ({ city, temp: 22 }));

    const agent = chat.customAgent({
      id: "session.handover.toolcall",
      run: async (payload) => {
        const session = chat.createSession(payload, { signal: new AbortController().signal });
        for await (const turn of session) {
          capture.handover = turn.handover;
          const result = streamText({
            model: new MockLanguageModelV3({
              doStream: async () => ({ stream: textStream("the weather in tokyo is 22°C") }),
            }),
            messages: turn.messages,
            tools: { weather: weatherToolWithExecute(toolExecute) },
            abortSignal: turn.signal,
          });
          await turn.complete(result);
          return;
        }
      },
    });

    const harness = mockChatAgent(agent, { chatId: "s-tool", mode: "handover-prepare" });
    try {
      await harness.sendHandover({
        partialAssistantMessage: TOOL_CALL_PARTIAL,
        messageId: "asst-msg-5",
        isFinal: false,
      });
      // Surfaced as a non-final handover turn, and the handed-over tool round
      // resumed (agent-side execute ran). Full step-2-text path covered by T29.
      expect(capture.handover).toEqual({ isFinal: false });
      expect(toolExecute).toHaveBeenCalledWith(
        expect.objectContaining({ city: "tokyo" }),
        expect.anything()
      );
    } finally {
      await harness.close();
    }
  });
});
