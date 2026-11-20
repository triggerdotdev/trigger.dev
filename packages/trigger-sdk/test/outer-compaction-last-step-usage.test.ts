/**
 * The between-turns compaction check decides on the size of the context the model
 * held on its LAST call. The AI SDK's `totalUsage` sums every step of a turn, so a
 * tool-using turn would otherwise report its context several times over and a
 * single question could compact the conversation.
 */
import { mockChatAgent } from "../src/v3/test/index.js";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, streamText, tool, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat, type ShouldCompactEvent } from "../src/v3/ai.js";

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
const toolStep = (input: number): LanguageModelV3StreamPart[] => [
  { type: "tool-call", toolCallId: "tc_1", toolName: "lookup", input: "{}" },
  {
    type: "finish",
    finishReason: { unified: "tool-calls", raw: "tool-calls" },
    usage: usage(input, 10),
  },
];
const textStep = (input: number): LanguageModelV3StreamPart[] => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "found it" },
  { type: "text-end", id: "t" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(input, 20) },
];
const userMessage = (text: string, id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});
async function waitFor(check: () => boolean, label: string, timeoutMs = 8_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out: ${label}`);
}

describe("outer-loop compaction on a tool-using turn", () => {
  it(
    "is asked about the last step's context, with the turn's sum alongside",
    { timeout: 30_000 },
    async () => {
      const events: ShouldCompactEvent[] = [];
      let turns = 0;
      let call = 0;
      const model = new MockLanguageModelV3({
        doStream: async () => {
          const chunks = call++ === 0 ? toolStep(1_000) : textStep(1_300);
          return { stream: simulateReadableStream({ chunks }) };
        },
      });
      const agent = chat.agent({
        id: "outer-compaction-last-step-usage",
        tools: {
          lookup: tool({
            description: "lookup",
            inputSchema: z.object({}),
            execute: async () => ({ ok: true }),
          }),
        },
        compaction: {
          shouldCompact: (event) => {
            if (event.source === "outer") events.push(event);
            return false;
          },
          summarize: async () => "unused",
        },
        onTurnComplete: async () => {
          turns++;
        },
        run: async ({ messages, signal, tools }) =>
          streamText({
            model,
            messages,
            tools,
            abortSignal: signal,
            stopWhen: ({ steps }) => steps.length >= 3,
          }),
      });
      const harness = mockChatAgent(agent, { chatId: "outer-compaction-last-step-usage" });
      try {
        await harness.sendMessage(userMessage("what errors?", "u1"));
        await waitFor(() => turns >= 1 && events.length >= 1, "turn 0 + outer check");
        const event = events[0]!;
        expect(event.inputTokens).toBe(1_300);
        expect(event.usage?.inputTokens).toBe(1_300);
        expect(event.turnUsage?.inputTokens).toBe(2_300);
        expect(event.totalUsage?.inputTokens).toBe(2_300);
      } finally {
        await harness.close();
      }
    }
  );
});

describe("outer-loop compaction with a custom stream source", () => {
  const sdkUsage = (input: number) => ({
    inputTokens: input,
    outputTokens: 10,
    totalTokens: input + 10,
    inputTokenDetails: {},
    outputTokenDetails: {},
  });

  // Catches: a custom `toUIMessageStream()` source that exposes `usage` (the last step's) but no
  // `steps` losing that usage, so compaction was asked about the turn's sum instead.
  it(
    "uses the source's usage as the last step's when it has no steps",
    { timeout: 30_000 },
    async () => {
      const events: ShouldCompactEvent[] = [];
      let turns = 0;
      const model = new MockLanguageModelV3({
        doStream: async () => ({ stream: simulateReadableStream({ chunks: textStep(1_300) }) }),
      });
      const agent = chat.agent({
        id: "outer-compaction-custom-source-usage",
        compaction: {
          shouldCompact: (event) => {
            if (event.source === "outer") events.push(event);
            return false;
          },
          summarize: async () => "unused",
        },
        onTurnComplete: async () => {
          turns++;
        },
        run: async ({ messages, signal }) => {
          const result = streamText({ model, messages, abortSignal: signal });
          return {
            toUIMessageStream: (options?: any) => result.toUIMessageStream(options),
            usage: Promise.resolve(sdkUsage(1_300)),
            totalUsage: Promise.resolve(sdkUsage(2_300)),
          } as any;
        },
      });
      const harness = mockChatAgent(agent, { chatId: "outer-compaction-custom-source-usage" });
      try {
        await harness.sendMessage(userMessage("what errors?", "u1"));
        await waitFor(() => turns >= 1 && events.length >= 1, "turn 0 + outer check");
        const event = events[0]!;
        expect(event.inputTokens).toBe(1_300);
        expect(event.turnUsage?.inputTokens).toBe(2_300);
      } finally {
        await harness.close();
      }
    }
  );
});

describe("chat.createSession outer-loop compaction on a tool-using turn", () => {
  // Catches: a custom-agent session asking about the turn's summed usage instead of the last
  // step's, which AI SDK 7's `result.usage` returns.
  it(
    "is asked about the last step's context, with the turn's sum alongside",
    { timeout: 30_000 },
    async () => {
      const events: ShouldCompactEvent[] = [];
      let call = 0;
      const model = new MockLanguageModelV3({
        doStream: async () => {
          const chunks = call++ === 0 ? toolStep(1_000) : textStep(1_300);
          return { stream: simulateReadableStream({ chunks }) };
        },
      });
      const agent = chat.customAgent({
        id: "createsession-last-step-usage",
        run: async (payload, { signal }) => {
          const session = chat.createSession(payload, {
            signal,
            idleTimeoutInSeconds: 1,
            compaction: {
              shouldCompact: (event) => {
                if (event.source === "outer") events.push(event);
                return false;
              },
              summarize: async () => "unused",
            },
          });
          for await (const turn of session) {
            await turn.complete(
              streamText({
                model,
                messages: turn.messages,
                abortSignal: turn.signal,
                tools: {
                  lookup: tool({
                    description: "lookup",
                    inputSchema: z.object({}),
                    execute: async () => ({ ok: true }),
                  }),
                },
                stopWhen: ({ steps }) => steps.length >= 3,
              })
            );
          }
        },
      });
      const harness = mockChatAgent(agent, { chatId: "createsession-last-step-usage" });
      try {
        await harness.sendMessage(userMessage("what errors?", "u1"));
        await waitFor(() => events.length >= 1, "outer check");
        const event = events[0]!;
        expect(event.inputTokens).toBe(1_300);
        expect(event.turnUsage?.inputTokens).toBe(2_300);
      } finally {
        await harness.close();
      }
    }
  );
});
