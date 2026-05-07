// Stress-test chat.agent. Emits a configurable number of `text-delta`
// chunks of a configurable size — no LLM call, no tokens spent. Lets us
// stress the dashboard's session detail view (rendered conversation +
// raw stream tabs) with deterministic load.
//
// Config is parsed from the last user message's text. Two formats:
//   "1000 10"           → chunkCount=1000, chunkSize=10
//   "1000 10 messages"  → chunkCount messages of one delta each
//
// Defaults: 1000 chunks × 10 chars, single message.

import { chat } from "@trigger.dev/sdk/ai";
import { type UIMessage, simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

type StressConfig = {
  chunkCount: number;
  chunkSize: number;
  manyMessages: boolean;
};

function parseConfig(messages: UIMessage[]): StressConfig {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text =
    lastUser?.parts?.[0]?.type === "text" ? lastUser.parts[0].text.trim() : "";
  const parts = text.split(/\s+/);
  const chunkCount = Number(parts[0]);
  const chunkSize = Number(parts[1]);
  const manyMessages = parts[2] === "messages";
  return {
    chunkCount: Number.isFinite(chunkCount) && chunkCount > 0 ? chunkCount : 1000,
    chunkSize: Number.isFinite(chunkSize) && chunkSize > 0 ? chunkSize : 10,
    manyMessages,
  };
}

function buildModelStream(config: StressConfig): LanguageModelV3StreamPart[] {
  const delta = "x".repeat(config.chunkSize);
  // Each `text-start`/`text-end` pair maps to a separate assistant message
  // in the AI SDK pipeline when `manyMessages` is set; without it, all
  // deltas accumulate into a single message.
  if (config.manyMessages) {
    const stream: LanguageModelV3StreamPart[] = [];
    for (let i = 0; i < config.chunkCount; i++) {
      const id = `t${i}`;
      stream.push({ type: "text-start", id });
      stream.push({ type: "text-delta", id, delta });
      stream.push({ type: "text-end", id });
    }
    stream.push({
      type: "finish",
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: {
          total: config.chunkCount,
          text: config.chunkCount,
          reasoning: undefined,
        },
      },
    });
    return stream;
  }

  const stream: LanguageModelV3StreamPart[] = [{ type: "text-start", id: "t1" }];
  for (let i = 0; i < config.chunkCount; i++) {
    stream.push({ type: "text-delta", id: "t1", delta });
  }
  stream.push({ type: "text-end", id: "t1" });
  stream.push({
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: {
        total: config.chunkCount,
        text: config.chunkCount,
        reasoning: undefined,
      },
    },
  });
  return stream;
}

export const stressEmit = chat.agent({
  id: "stress-emit",
  run: async ({ messages, signal }) => {
    const config = parseConfig(messages);
    const chunks = buildModelStream(config);
    return streamText({
      model: new MockLanguageModelV3({
        doStream: async () => ({ stream: simulateReadableStream({ chunks }) }),
      }),
      messages,
      abortSignal: signal,
    });
  },
});
