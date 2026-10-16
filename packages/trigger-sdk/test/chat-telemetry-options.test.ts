import { mockChatAgent } from "../src/v3/test/index.js";

import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chat } from "../src/v3/ai.js";

const exporter = new InMemorySpanExporter();

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

function model() {
  return new MockLanguageModelV3({ doStream: async () => ({ stream: textStream("ok") }) });
}

const secret = "my email is someone@example.com";

function userMessage() {
  return { id: "u-1", role: "user" as const, parts: [{ type: "text" as const, text: secret }] };
}

function turnSpan() {
  const span = exporter.getFinishedSpans().find((s) => s.name === "chat turn 1");
  expect(span).toBeDefined();
  return span!;
}

function recordsSecret(attributes: Record<string, unknown>) {
  return Object.values(attributes).some(
    (value) => typeof value === "string" && value.includes("someone@example.com")
  );
}

describe("chat.agent telemetry options", () => {
  beforeEach(() => {
    exporter.reset();
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
    );
  });

  afterEach(() => {
    trace.disable();
  });

  it("records the user message and client data on the turn span by default", async () => {
    const agent = chat.agent({
      id: "chat-telemetry-options.default",
      run: async ({ messages, signal, streamText }) =>
        streamText({ model: model(), messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, {
      chatId: "telemetry-default",
      clientData: { userEmail: "someone@example.com" },
    });
    try {
      await harness.sendMessage(userMessage());
    } finally {
      await harness.close();
    }

    const attributes = turnSpan().attributes;
    expect(attributes["chat.user_message"]).toBe(secret);
    expect(attributes["chat.client_data"]).toBe('{"userEmail":"someone@example.com"}');
  });

  it("leaves the user message and client data off the turn span when disabled", async () => {
    const agent = chat.agent({
      id: "chat-telemetry-options.disabled",
      telemetry: { recordUserMessage: false, recordClientData: false },
      run: async ({ messages, signal, streamText }) =>
        streamText({ model: model(), messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, {
      chatId: "telemetry-disabled",
      clientData: { userEmail: "someone@example.com" },
    });
    try {
      await harness.sendMessage(userMessage());
    } finally {
      await harness.close();
    }

    const attributes = turnSpan().attributes;
    expect(attributes["chat.user_message"]).toBeUndefined();
    expect(attributes["chat.client_data"]).toBeUndefined();
    expect(recordsSecret(attributes)).toBe(false);
  });
});
