/**
 * A head-start handover splices the warm step's pending tool call into the model
 * lane. When the agent's response then completes that same message under the same
 * id, the lane's copy of the partial has to be replaced, not left in front of the
 * response: otherwise the next turn sends the same `tool_use` id twice and the
 * provider rejects the request.
 */
import { mockChatAgent } from "../src/v3/test/index.js";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { simulateReadableStream, streamText, tool, type UIMessage } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { chat } from "../src/v3/ai.js";

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const finish = (r: "stop" | "tool-calls"): LanguageModelV3StreamPart => ({
  type: "finish",
  finishReason: { unified: r, raw: r },
  usage: USAGE,
});
const textStep = (t: string): LanguageModelV3StreamPart[] => [
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: t },
  { type: "text-end", id: "t" },
  finish("stop"),
];
const toolStep = (id: string): LanguageModelV3StreamPart[] => [
  { type: "tool-call", toolCallId: id, toolName: "lookup", input: "{}" },
  finish("tool-calls"),
];
const userMessage = (text: string, id: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

function toolUseIds(prompt: unknown): string[] {
  const ids: string[] = [];
  for (const m of prompt as Array<{ role: string; content: unknown }>) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content as Array<{ type: string; toolCallId?: string }>)
      if (p.type === "tool-call" && p.toolCallId) ids.push(p.toolCallId);
  }
  return ids;
}

for (const withMessageId of [false, true]) {
  describe(`a head-start turn whose handed-over tool call is followed by more steps (messageId=${withMessageId})`, () => {
    it("leaves the next turn one copy of each tool call", { timeout: 30_000 }, async () => {
      const prompts: unknown[] = [];
      const steps = [toolStep("tc_2"), textStep("found it"), textStep("second answer")];
      let call = 0;
      const model = new MockLanguageModelV3({
        doStream: async (o) => {
          prompts.push(o.prompt);
          const c = steps[Math.min(call++, steps.length - 1)]!;
          return { stream: simulateReadableStream({ chunks: c }) };
        },
      });
      const agent = chat.agent({
        id: `handover-lane-replace-${withMessageId}`,
        tools: {
          lookup: tool({
            description: "lookup",
            inputSchema: z.object({}),
            execute: async () => ({ ok: true }),
          }),
        },
        run: async ({ messages, signal, tools }) =>
          streamText({
            model,
            messages,
            tools,
            abortSignal: signal,
            stopWhen: ({ steps }) => steps.length >= 5,
          }),
      });
      const harness = mockChatAgent(agent, {
        chatId: `handover-lane-replace-${withMessageId}`,
        mode: "handover-prepare",
        headStartMessages: [userMessage("what errors?", "u1")],
      });
      try {
        await harness.sendHandover({
          partialAssistantMessage: [
            {
              role: "assistant",
              content: [
                { type: "tool-call", toolCallId: "tc_hs", toolName: "lookup", input: {} },
                { type: "tool-approval-request", approvalId: "ap", toolCallId: "tc_hs" },
              ],
            },
            {
              role: "tool",
              content: [{ type: "tool-approval-response", approvalId: "ap", approved: true }],
            },
          ],
          isFinal: false,
          ...(withMessageId ? { messageId: "msg_headstart" } : {}),
        } as never);
        await new Promise((r) => setTimeout(r, 50));
        await harness.sendMessage(userMessage("follow up", "u2"));
        const last = prompts[prompts.length - 1];
        const ids = toolUseIds(last);
        expect(ids).toEqual(["tc_hs", "tc_2"]);
        // The lane is the completed conversation, in order, with the partial gone.
        const roles = (last as Array<{ role: string }>).map((m) => m.role);
        expect(roles).toEqual([
          "user",
          "assistant",
          "tool",
          "assistant",
          "tool",
          "assistant",
          "user",
        ]);
      } finally {
        await harness.close();
      }
    });
  });
}
