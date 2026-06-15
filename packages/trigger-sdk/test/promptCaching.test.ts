// Import the test harness FIRST so the resource catalog is installed
import { mockChatAgent } from "../src/v3/test/index.js";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { simulateReadableStream, streamText } from "ai";
import { chat } from "../src/v3/ai.js";

function userMessage(text: string, id?: string) {
  return {
    id: id ?? `u-${Math.random().toString(36).slice(2)}`,
    role: "user" as const,
    parts: [{ type: "text" as const, text }],
  };
}

function textStream(text: string) {
  const chunks: LanguageModelV3StreamPart[] = [
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
  return simulateReadableStream({ chunks });
}

/** Capture the rendered system message handed to the provider. */
type Captured = { system?: { role: string; content: unknown; providerOptions?: any } };

function makeModel(capture: Captured) {
  return new MockLanguageModelV3({
    doStream: async (opts) => {
      capture.system = opts.prompt.find((m) => m.role === "system") as Captured["system"];
      return { stream: textStream("ok") };
    },
  });
}

const SYSTEM = "You are a helpful assistant for tests.";

describe("chat prompt caching — system providerOptions", () => {
  it("emits a plain system prompt with no providerOptions by default", async () => {
    const cap: Captured = {};
    const model = makeModel(cap);

    const agent = chat.agent({
      id: "prompt-caching.default",
      onChatStart: async () => {
        chat.prompt.set(SYSTEM);
      },
      run: async ({ messages, signal }) =>
        streamText({ model, messages, abortSignal: signal, ...chat.toStreamTextOptions() }),
    });

    const harness = mockChatAgent(agent, { chatId: "pc-default" });
    try {
      await harness.sendMessage(userMessage("hi"));
      await new Promise((r) => setTimeout(r, 20));
      expect(cap.system?.content).toContain("helpful assistant");
      expect(cap.system?.providerOptions).toBeUndefined();
    } finally {
      await harness.close();
    }
  });

  it("attaches cacheControl via the toStreamTextOptions sugar", async () => {
    const cap: Captured = {};
    const model = makeModel(cap);

    const agent = chat.agent({
      id: "prompt-caching.sugar",
      onChatStart: async () => {
        chat.prompt.set(SYSTEM);
      },
      run: async ({ messages, signal }) =>
        streamText({
          model,
          messages,
          abortSignal: signal,
          ...chat.toStreamTextOptions({ cacheControl: { type: "ephemeral" } }),
        }),
    });

    const harness = mockChatAgent(agent, { chatId: "pc-sugar" });
    try {
      await harness.sendMessage(userMessage("hi"));
      await new Promise((r) => setTimeout(r, 20));
      expect(cap.system?.content).toContain("helpful assistant");
      expect(cap.system?.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
    } finally {
      await harness.close();
    }
  });

  it("attaches systemProviderOptions verbatim", async () => {
    const cap: Captured = {};
    const model = makeModel(cap);

    const agent = chat.agent({
      id: "prompt-caching.explicit",
      onChatStart: async () => {
        chat.prompt.set(SYSTEM);
      },
      run: async ({ messages, signal }) =>
        streamText({
          model,
          messages,
          abortSignal: signal,
          ...chat.toStreamTextOptions({
            systemProviderOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
          }),
        }),
    });

    const harness = mockChatAgent(agent, { chatId: "pc-explicit" });
    try {
      await harness.sendMessage(userMessage("hi"));
      await new Promise((r) => setTimeout(r, 20));
      expect(cap.system?.providerOptions?.anthropic?.cacheControl).toEqual({
        type: "ephemeral",
        ttl: "1h",
      });
    } finally {
      await harness.close();
    }
  });

  it("carries providerOptions set on chat.prompt.set()", async () => {
    const cap: Captured = {};
    const model = makeModel(cap);

    const agent = chat.agent({
      id: "prompt-caching.prompt-set",
      onChatStart: async () => {
        chat.prompt.set(SYSTEM, {
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        });
      },
      run: async ({ messages, signal }) =>
        streamText({ model, messages, abortSignal: signal, ...chat.toStreamTextOptions() }),
    });

    const harness = mockChatAgent(agent, { chatId: "pc-prompt-set" });
    try {
      await harness.sendMessage(userMessage("hi"));
      await new Promise((r) => setTimeout(r, 20));
      expect(cap.system?.providerOptions?.anthropic?.cacheControl).toEqual({ type: "ephemeral" });
    } finally {
      await harness.close();
    }
  });

  it("call-site systemProviderOptions overrides chat.prompt.set providerOptions", async () => {
    const cap: Captured = {};
    const model = makeModel(cap);

    const agent = chat.agent({
      id: "prompt-caching.precedence",
      onChatStart: async () => {
        chat.prompt.set(SYSTEM, {
          providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
        });
      },
      run: async ({ messages, signal }) =>
        streamText({
          model,
          messages,
          abortSignal: signal,
          ...chat.toStreamTextOptions({
            systemProviderOptions: { anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } },
          }),
        }),
    });

    const harness = mockChatAgent(agent, { chatId: "pc-precedence" });
    try {
      await harness.sendMessage(userMessage("hi"));
      await new Promise((r) => setTimeout(r, 20));
      // The call-site option wins (ttl: "1h"), not the prompt-set default.
      expect(cap.system?.providerOptions?.anthropic?.cacheControl).toEqual({
        type: "ephemeral",
        ttl: "1h",
      });
    } finally {
      await harness.close();
    }
  });
});
