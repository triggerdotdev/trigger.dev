import type { LanguageModelV3Prompt, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

/** What the model does on one call: call these tools, or answer with text. */
export type Step = { tools: string[] } | { text: string };

/** One model call: the turn it belongs to, what it was sent, and what it called. */
export type Call = {
  turn: number;
  prompt: LanguageModelV3Prompt;
  toolCallIds: string[];
};

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/**
 * A model that follows `script` call by call, across every turn of a
 * conversation, and records each prompt without the system messages. Tool
 * call ids are unique for the whole conversation (`<tool>-<call>-<n>`). Calls
 * past the end of the script answer with `answer-<call>`.
 */
export function scriptedModel(script: Step[]) {
  const calls: Call[] = [];
  let turn = 0;
  const model = new MockLanguageModelV3({
    doStream: async ({ prompt }) => {
      const index = calls.length;
      const step = script[index] ?? { text: `answer-${index}` };
      const tools = "tools" in step ? step.tools : [];
      const toolCallIds = tools.map((name, n) => `${name}-${index}-${n}`);
      calls.push({ turn, prompt: prompt.filter((m) => m.role !== "system"), toolCallIds });
      const chunks: LanguageModelV3StreamPart[] =
        "tools" in step
          ? [
              ...tools.map((toolName, n): LanguageModelV3StreamPart => ({
                type: "tool-call",
                toolCallId: toolCallIds[n]!,
                toolName,
                input: "{}",
              })),
              { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" }, usage },
            ]
          : [
              { type: "text-start", id: `t-${index}` },
              { type: "text-delta", id: `t-${index}`, delta: step.text },
              { type: "text-end", id: `t-${index}` },
              { type: "finish", finishReason: { unified: "stop", raw: "end_turn" }, usage },
            ];
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
  return {
    model,
    calls,
    /** Every call after this belongs to the next turn. */
    nextTurn: () => {
      turn++;
    },
  };
}

export const userMessage = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

export function makeGate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** Polls `check`, failing with `label` before vitest's own 5 s test timeout. */
export async function waitFor(check: () => boolean, label: string, timeoutMs = 4_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
