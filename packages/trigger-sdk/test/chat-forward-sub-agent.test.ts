import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage, UIMessageChunk } from "ai";
import { simulateReadableStream, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";
import { createSubAgentMessages, SUB_AGENT_DATA_TYPE } from "../src/v3/subAgentStream.js";

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

const userMessage = (text: string, id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

const callResearch: LanguageModelV3StreamPart[] = [
  {
    type: "tool-call",
    toolCallId: "call_research",
    toolName: "research",
    input: JSON.stringify({ topic: "queues" }),
  },
  { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage: USAGE },
];

const answer: LanguageModelV3StreamPart[] = [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "Here is the summary." },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: USAGE },
];

function subAgentReply(deltas: number): UIMessageChunk[] {
  return [
    { type: "start", messageId: "sub-1" },
    { type: "start-step" },
    { type: "tool-input-available", toolCallId: "fetch-1", toolName: "fetchPage", input: {} },
    { type: "tool-output-available", toolCallId: "fetch-1", output: { page: "x".repeat(20_000) } },
    { type: "text-start", id: "s1" },
    ...Array.from({ length: deltas }, (_, index): UIMessageChunk => ({
      type: "text-delta",
      id: "s1",
      delta: `finding${index} `,
    })),
    { type: "text-end", id: "s1" },
    { type: "finish-step" },
    { type: "finish" },
  ];
}

function slowStreamOf(chunks: UIMessageChunk[]) {
  let index = 0;
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      if (index >= chunks.length) return controller.close();
      if (index % 25 === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      controller.enqueue(structuredClone(chunks[index++]!));
    },
  });
}

function lastText(message: UIMessage | undefined) {
  const texts = (message?.parts ?? []).filter(
    (part): part is { type: "text"; text: string } => part.type === "text"
  );
  return texts.at(-1)?.text ?? "";
}

function failingStreamOf(chunks: UIMessageChunk[], error: Error) {
  const pending = structuredClone(chunks);
  return new ReadableStream<UIMessageChunk>({
    pull(controller) {
      const next = pending.shift();
      if (next) controller.enqueue(next);
      else controller.error(error);
    },
  });
}

describe("chat.forwardSubAgent", () => {
  it(
    "streams the sub-agent as transient chunks and returns one final tool output",
    { timeout: 30_000 },
    async () => {
      const prompts: LanguageModelV3Prompt[] = [];
      let call = 0;
      const model = new MockLanguageModelV3({
        doStream: async ({ prompt }) => {
          prompts.push(prompt);
          return {
            stream: simulateReadableStream({ chunks: call++ === 0 ? callResearch : answer }),
          };
        },
      });

      const reply = subAgentReply(400);
      const tools = {
        research: tool({
          description: "Delegate research to a sub-agent.",
          inputSchema: z.object({ topic: z.string() }),
          execute: async (_input, { toolCallId }) =>
            chat.forwardSubAgent(slowStreamOf(reply), { toolCallId }),
          toModelOutput: ({ output }) => ({ type: "text", value: lastText(output) }),
        }),
      };

      let responseMessage: UIMessage | undefined;
      const agent = chat.agent({
        id: "forward-sub-agent",
        tools,
        onTurnComplete: async (event) => {
          responseMessage = event.responseMessage;
        },
        run: async ({ messages, signal, streamText }) =>
          streamText({
            model,
            messages,
            tools,
            abortSignal: signal,
            stopWhen: stepCountIs(3),
          }),
      });

      const harness = mockChatAgent(agent, { chatId: "forward-sub-agent" });
      try {
        const turn = await harness.sendMessage(userMessage("research queues", "u-1"));

        const forwarded = turn.chunks.filter((chunk) => chunk.type === SUB_AGENT_DATA_TYPE);
        expect(forwarded.length).toBeGreaterThan(1);
        expect(forwarded.length).toBeLessThan(reply.length);

        const outputs = turn.chunks.filter(
          (chunk): chunk is Extract<UIMessageChunk, { type: "tool-output-available" }> =>
            chunk.type === "tool-output-available" && chunk.toolCallId === "call_research"
        );
        expect(outputs).toHaveLength(1);
        expect(outputs[0]!.preliminary).toBeFalsy();
        expect(lastText(outputs[0]!.output as UIMessage)).toBe(lastText(await finalOf(reply)));

        const store = createSubAgentMessages({ throttleMs: 5 });
        for (const chunk of forwarded) store.onData(chunk as { type: string; data: unknown });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(store.get("call_research")).toEqual(outputs[0]!.output);

        const answeringPrompt = JSON.stringify(prompts[1]);
        expect(answeringPrompt).toContain(lastText(await finalOf(reply)));
        expect(answeringPrompt).not.toContain("x".repeat(1_000));

        const persisted = JSON.stringify(responseMessage);
        expect(persisted).not.toContain(SUB_AGENT_DATA_TYPE);
        expect(persisted).toContain("finding399");
      } finally {
        await harness.close();
      }
    }
  );

  it(
    "rejects with the sub-agent's error when its stream fails, after forwarding what arrived",
    { timeout: 30_000 },
    async () => {
      let call = 0;
      const model = new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({ chunks: call++ === 0 ? callResearch : answer }),
        }),
      });

      const partial = subAgentReply(20).slice(0, 10);
      const tools = {
        research: tool({
          description: "Delegate research to a sub-agent.",
          inputSchema: z.object({ topic: z.string() }),
          execute: async (_input, { toolCallId }) =>
            chat.forwardSubAgent(failingStreamOf(partial, new Error("sub-agent run crashed")), {
              toolCallId,
            }),
          toModelOutput: ({ output }) => ({ type: "text", value: lastText(output) }),
        }),
      };

      const agent = chat.agent({
        id: "forward-sub-agent-failure",
        tools,
        run: async ({ messages, signal, streamText }) =>
          streamText({
            model,
            messages,
            tools,
            abortSignal: signal,
            stopWhen: stepCountIs(3),
          }),
      });

      const harness = mockChatAgent(agent, { chatId: "forward-sub-agent-failure" });
      try {
        const turn = await harness.sendMessage(userMessage("research queues", "u-1"));

        const forwarded = turn.chunks.filter((chunk) => chunk.type === SUB_AGENT_DATA_TYPE);
        const forwardedChunks = forwarded.flatMap(
          (chunk) => (chunk as unknown as { data: { chunks: UIMessageChunk[] } }).data.chunks
        );
        expect(forwardedChunks).toHaveLength(partial.length);

        const toolResults = turn.chunks.filter(
          (chunk) =>
            (chunk.type === "tool-output-available" || chunk.type === "tool-output-error") &&
            chunk.toolCallId === "call_research"
        );
        expect(toolResults).toHaveLength(1);
        expect(toolResults[0]).toMatchObject({
          type: "tool-output-error",
          errorText: expect.stringContaining("sub-agent run crashed"),
        });
      } finally {
        await harness.close();
      }
    }
  );
});

async function finalOf(chunks: UIMessageChunk[]) {
  const store = createSubAgentMessages({ throttleMs: 1 });
  store.onData({
    type: SUB_AGENT_DATA_TYPE,
    data: { toolCallId: "reference", seq: 0, chunks: structuredClone(chunks) },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return store.get("reference");
}
