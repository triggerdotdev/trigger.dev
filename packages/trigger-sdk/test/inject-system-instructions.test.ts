// Import the test harness FIRST — installs the resource catalog so
// `chat.agent()` below registers its task functions correctly.
import { mockChatAgent } from "../src/v3/test/index.js";

import { describe, expect, it } from "vitest";
import { chat } from "../src/v3/ai.js";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

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

describe("chat.inject with a system role (TRI-13380)", () => {
  it("goes to the instructions lane instead of poisoning the prompt", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("ok") }),
    });

    let injected = false;

    const agent = chat.agent({
      id: "inject-system-instructions",
      onBoot: async () => {
        chat.prompt.set({
          promptId: "base",
          version: 1,
          labels: ["local"],
          text: "You are a helpful assistant.",
          model: undefined,
          config: undefined,
          toAISDKTelemetry: () => ({ experimental_telemetry: { isEnabled: true, metadata: {} } }),
        });
      },
      onTurnComplete: async () => {
        if (injected) return;
        injected = true;
        /**
         * The shape every docs example uses. On ai@7 a system message inside
         * `messages` is rejected by `standardizePrompt` for every provider, so
         * this used to kill the next turn — an error chunk reading "An error
         * occurred." and an assistant message with no parts.
         */
        chat.inject([{ role: "system", content: "The user just upgraded to Pro." }]);
      },
      run: async ({ messages, signal }) =>
        streamText({
          ...chat.toStreamTextOptions(),
          model,
          messages,
          abortSignal: signal,
        }),
    });

    const harness = mockChatAgent(agent, { chatId: "inject-system-instructions" });

    try {
      await harness.sendMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "one" }] });
      await new Promise((r) => setTimeout(r, 40));

      const turn = await harness.sendMessage({
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "two" }],
      });
      await new Promise((r) => setTimeout(r, 40));

      // The turn survives.
      const errors = turn.rawChunks.filter((c) => (c as { type?: string })?.type === "error");
      expect(errors).toEqual([]);

      // The injected context arrives as a system block, alongside the base prompt,
      // and never as a system message inside `messages`.
      const prompt = model.doStreamCalls.at(-1)!.prompt;
      const systemBlocks = prompt.filter((m) => m.role === "system");
      const asText = JSON.stringify(systemBlocks);

      expect(asText).toContain("You are a helpful assistant.");
      expect(asText).toContain("The user just upgraded to Pro.");

      const nonSystem = prompt.filter((m) => m.role !== "system");
      expect(JSON.stringify(nonSystem)).not.toContain("upgraded to Pro");
    } finally {
      await harness.close();
    }
  });
  it("emits one system value whether or not the base block is cached", async () => {
    /**
     * Never an array. ai@6+ accepts `Array<SystemModelMessage>` and would let a
     * cached base block keep its cache entry, but ai@5 rejects an array outright
     * ("Invalid prompt: system must be a string") while accepting a single
     * structured block — and the peer range still spans v5. So a plain base
     * concatenates into a string, and a cached base absorbs the injection into its
     * own content, keeping its provider options.
     */
    const shapes: unknown[] = [];

    function agentFor(id: string, cacheControl: boolean) {
      let injected = false;
      return chat.agent({
        id,
        onBoot: async () => {
          chat.prompt.set({
            promptId: "base",
            version: 1,
            labels: ["local"],
            text: "Base instructions.",
            model: undefined,
            config: undefined,
            toAISDKTelemetry: () => ({
              experimental_telemetry: { isEnabled: true, metadata: {} },
            }),
          });
        },
        onTurnComplete: async () => {
          if (injected) return;
          injected = true;
          chat.inject([{ role: "system", content: "Amendment." }]);
        },
        run: async ({ messages, signal }) => {
          const options = cacheControl
            ? chat.toStreamTextOptions({ cacheControl: { type: "ephemeral" } })
            : chat.toStreamTextOptions();
          shapes.push(Array.isArray(options.system) ? "array" : typeof options.system);
          return streamText({
            ...options,
            model: new MockLanguageModelV3({
              doStream: async () => ({ stream: textStream("ok") }),
            }),
            messages,
            abortSignal: signal,
          });
        },
      });
    }

    for (const [id, cacheControl] of [
      ["shape-plain", false],
      ["shape-cached", true],
    ] as const) {
      const harness = mockChatAgent(agentFor(id, cacheControl), { chatId: id });
      try {
        await harness.sendMessage({ id: "u1", role: "user", parts: [{ type: "text", text: "one" }] });
        await new Promise((r) => setTimeout(r, 40));
        await harness.sendMessage({ id: "u2", role: "user", parts: [{ type: "text", text: "two" }] });
        await new Promise((r) => setTimeout(r, 40));
      } finally {
        await harness.close();
      }
    }

    // [plain turn 1, plain turn 2 (injected), cached turn 1, cached turn 2 (injected)]
    expect(shapes).toEqual(["string", "string", "object", "object"]);
  });

});
