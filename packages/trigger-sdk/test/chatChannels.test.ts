import { mockChatAgent, recordingChannelConnector } from "../src/v3/test/index.js";

import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_TURN_ERROR_MESSAGE,
  type ChannelErrorContext,
  type ChannelErrorMessage,
  chat,
  type ChannelRunSurface,
  __makeChannelStreamEditorForTests,
  __makeChannelStreamTapForTests,
  __setTranscriptStorageForTests,
} from "../src/v3/ai.js";
import { memoryTranscriptStorage } from "../src/v3/transcriptStorage.js";
import { webhooks } from "../src/v3/webhooks.js";
import { simulateReadableStream, stepCountIs, streamText, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { z } from "zod/v4";

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

function toolCallStream(toolCallId: string, toolName: string, input: unknown) {
  return simulateReadableStream({
    chunks: [
      { type: "tool-input-start", id: toolCallId, toolName },
      { type: "tool-input-delta", id: toolCallId, delta: JSON.stringify(input) },
      { type: "tool-input-end", id: toolCallId },
      { type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) },
      {
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 10, text: 0, reasoning: undefined },
        },
      },
    ] as LanguageModelV3StreamPart[],
  });
}

describe("chat.agent channels", () => {
  it("delivers a channel event as a turn and posts the reply back through the connector", async () => {
    const seenText: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("hello world") }),
    });

    const channel = recordingChannelConnector();

    const agent = chat.agent({
      id: "chatChannels.final-roundtrip",
      channels: [channel],
      run: async ({ messages, signal }) => {
        const last = messages[messages.length - 1];
        const content = last?.content;
        seenText.push(
          typeof content === "string"
            ? content
            : (content ?? [])
                .map((p) => (typeof p === "object" && p.type === "text" ? p.text : ""))
                .join("")
        );
        return streamText({ model, messages, abortSignal: signal });
      },
    });

    const harness = mockChatAgent(agent, { chatId: "chan-1" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi there", threadId: "chan-1" } });

      expect(seenText).toEqual(["hi there"]);

      expect(channel.acks).toHaveLength(1);
      expect(channel.acks[0]!.message.text).toBe("...");
      expect(channel.finalText()).toBe("hello world");

      const finalSend = channel.sent[channel.sent.length - 1]!;
      expect(finalSend.ctx.final).toBe(true);
      expect(finalSend.ctx.previousRef).toBe(channel.acks[0]!.ref);
    } finally {
      await harness.close();
    }
  });

  it("sendChannelEvent returns only after a slow connector's final send and reactions have landed", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("slow but sure") }),
    });
    const channel = recordingChannelConnector({
      reactions: { working: "eyes", done: "white_check_mark" },
    });
    const recordSend = channel.send!;
    (channel as { send: typeof recordSend }).send = async (message, ctx) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return recordSend(message, ctx);
    };
    const agent = chat.agent({
      id: "chatChannels.slow-egress",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "chan-slow" });
    try {
      await harness.sendChannelEvent({ event: { text: "take your time", threadId: "chan-slow" } });
      expect(channel.finalText()).toBe("slow but sure");
      expect(channel.reactionsApplied.map((r) => r.reaction.name)).toEqual([
        "eyes",
        "eyes",
        "white_check_mark",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("posts the plain reply, promptly, when the connector's outbound() throws on the final reply", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("this will not format") }),
    });
    const channel = recordingChannelConnector();
    (channel as { outbound?: (reply: { final?: boolean; text?: string }) => unknown }).outbound = (
      reply
    ) => {
      if (reply.final) throw new Error("outbound exploded");
      return { text: reply.text ?? "" };
    };
    const agent = chat.agent({
      id: "chatChannels.throwing-outbound",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "chan-throwing-outbound" });
    try {
      const startedAt = Date.now();
      await harness.sendChannelEvent({
        event: { text: "format this", threadId: "chan-throwing-outbound" },
      });
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(channel.finalText()).toBe("this will not format");
      const finalSend = channel.sent.filter((sent) => sent.ctx.final).at(-1)!;
      expect(finalSend.ctx.previousRef).toBe(channel.acks[0]!.ref);
    } finally {
      await harness.close();
    }
  });

  it("a continuation dispatches an unprocessed Slack delivery before a later browser message", async () => {
    const seen: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        const last = prompt[prompt.length - 1];
        const text =
          last && Array.isArray(last.content)
            ? last.content.map((part) => (part.type === "text" ? part.text : "")).join("")
            : "";
        seen.push(text);
        return { stream: textStream(`ack: ${text}`) };
      },
    });
    const channel = recordingChannelConnector();
    const agent = chat.agent({
      id: "chatChannels.recovery-order",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, {
      chatId: "chan-recovery-order",
      continuation: true,
      previousRunId: "run_prior",
    });
    harness.seedSessionInTail([
      { channelEvent: { event: { text: "first, from slack", threadId: "chan-recovery-order" } } },
      {
        id: "u-browser",
        role: "user",
        parts: [{ type: "text", text: "second, from the browser" }],
      } as never,
    ]);
    try {
      await harness.sendMessage({
        id: "u-live",
        role: "user",
        parts: [{ type: "text", text: "third, live" }],
      } as never);
      const finals = () =>
        channel.sent.filter((send) => send.ctx.final).map((send) => send.message.text);
      const deadline = Date.now() + 5_000;
      while (finals().length < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(seen).toEqual(["first, from slack", "second, from the browser", "third, live"]);
      // The Slack delivery bound the session to its thread, so the later browser turns egress
      // there too, in the same order.
      expect(finals()).toEqual([
        "ack: first, from slack",
        "ack: second, from the browser",
        "ack: third, live",
      ]);
    } finally {
      await harness.close();
    }
  });

  it("posts only the final answer when ack is null", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("done") }),
    });

    const channel = recordingChannelConnector({ ack: null });

    const agent = chat.agent({
      id: "chatChannels.no-ack",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-2" });
    try {
      await harness.sendChannelEvent({ event: { text: "yo", threadId: "chan-2" } });

      expect(channel.acks).toHaveLength(0);
      expect(channel.sent).toHaveLength(1);
      expect(channel.finalText()).toBe("done");
    } finally {
      await harness.close();
    }
  });

  it("records lifecycle reactions around a channel turn", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("ok") }),
    });

    const channel = recordingChannelConnector({
      reactions: { working: "eyes", done: "white_check_mark" },
    });

    const agent = chat.agent({
      id: "chatChannels.reactions",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-3" });
    try {
      await harness.sendChannelEvent({ event: { text: "go", threadId: "chan-3" } });

      const names = channel.reactionsApplied.map((r) => ({
        name: r.reaction.name,
        remove: r.reaction.remove ?? false,
      }));
      expect(names).toEqual([
        { name: "eyes", remove: false },
        { name: "eyes", remove: true },
        { name: "white_check_mark", remove: false },
      ]);
    } finally {
      await harness.close();
    }
  });

  it("still posts an authoritative final reply in stream delivery", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("streamed answer") }),
    });

    const channel = recordingChannelConnector({ delivery: "stream" });

    const agent = chat.agent({
      id: "chatChannels.stream-final",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-4" });
    try {
      await harness.sendChannelEvent({ event: { text: "stream please", threadId: "chan-4" } });

      expect(channel.finalText()).toBe("streamed answer");
    } finally {
      await harness.close();
    }
  });

  it("edits the placeholder to the error when a channel turn throws", async () => {
    const channel = recordingChannelConnector();

    const agent = chat.agent({
      id: "chatChannels.error-egress",
      channels: [channel],
      run: async () => {
        throw new Error("turn exploded");
      },
    });

    const harness = mockChatAgent(agent, { chatId: "chan-5" });
    try {
      await harness.sendChannelEvent({ event: { text: "cause an error", threadId: "chan-5" } });

      expect(channel.acks).toHaveLength(1);
      const finalSend = channel.sent[channel.sent.length - 1]!;
      expect(finalSend.ctx.final).toBe(true);
      expect(finalSend.ctx.previousRef).toBe(channel.acks[0]!.ref);
      expect(finalSend.message.text).toBe(CHANNEL_TURN_ERROR_MESSAGE);
    } finally {
      await harness.close();
    }
  });
});

describe("chat.agent channel binding", () => {
  it("answers a chat.event action turn into the channel the session is bound to", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("order confirmed") }),
    });

    const channel = recordingChannelConnector();
    const orderEvents = chat.event({
      id: "chatChannels.bound.order-events",
      endpoint: webhooks.endpoint.define({
        id: "chatChannels-bound-orders",
        source: webhooks.custom<{ orderId: string; customer: string }>({
          scheme: "shared-secret",
          placement: "header",
          fieldName: "x-test-signature",
        }),
      }),
      key: "{event.customer}",
      type: "order.event",
    });

    const seenActions: unknown[] = [];
    const agent = chat.agent({
      id: "chatChannels.bound-action-turn",
      channels: [channel],
      events: [orderEvents],
      onAction: async ({ action }) => {
        seenActions.push(action);
        return chat.turn();
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-bound-1" });
    try {
      // A Slack-style message binds the session to the thread.
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "t-bound", userId: "U1" } });
      expect(channel.finalText()).toBe("order confirmed");
      const channelSends = channel.sent.length;

      // A webhook delivery routed to the same session becomes a turn via chat.turn(): its answer
      // posts into the bound thread even though no channel event started it.
      await harness.sendWebhookAction({
        type: "order.event",
        event: { orderId: "o1", customer: "c1" },
        source: "custom",
        deliveryId: "whd_bound_1",
        externalDeliveryId: "evt_bound_1",
      });
      expect(seenActions).toHaveLength(1);
      expect(seenActions[0]).toMatchObject({
        type: "order.event",
        deliveryId: "whd_bound_1",
        externalDeliveryId: "evt_bound_1",
      });

      const bound = channel.sent.slice(channelSends);
      expect(bound).toHaveLength(1);
      expect(bound[0]!.ctx.bound).toBe(true);
      expect(bound[0]!.ctx.event).toBeUndefined();
      expect(bound[0]!.ctx.handle).toEqual({ threadId: "t-bound" });
      expect(bound[0]!.ctx.final).toBe(true);
      expect(bound[0]!.ctx.previousRef).toBeUndefined();
      expect(bound[0]!.message.text).toBe("order confirmed");
    } finally {
      await harness.close();
    }
  });

  it("delivers a webhook action that carries no externalDeliveryId", async () => {
    const seen: unknown[] = [];
    const legacyEvents = chat.event({
      id: "legacy-events",
      endpoint: webhooks.endpoint.define({
        id: "chatChannels-legacy",
        source: webhooks.custom({ scheme: "url-secret", placement: "query", paramName: "token" }),
      }),
      key: "{event.id}",
      type: "legacy.event",
    });
    const agent = chat.agent({
      id: "chatChannels.legacy-action",
      events: [legacyEvents],
      onAction: async ({ action }) => {
        seen.push({ deliveryId: action.deliveryId, externalDeliveryId: action.externalDeliveryId });
      },
      run: async () => undefined,
    });

    const harness = mockChatAgent(agent, { chatId: "chan-legacy-1" });
    try {
      await harness.sendWebhookAction({
        type: "legacy.event",
        event: { id: "e1" },
        deliveryId: "evt_old_1",
      });
      expect(seen).toEqual([{ deliveryId: "evt_old_1", externalDeliveryId: undefined }]);
    } finally {
      await harness.close();
    }
  });

  it("stamps channel provenance on messages and the storage context, and persists the binding", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("ok") }),
    });
    const storage = memoryTranscriptStorage();
    __setTranscriptStorageForTests(storage);

    const channel = recordingChannelConnector();
    const agent = chat.agent({
      id: "chatChannels.provenance",
      channels: [channel],
      onAction: async () => chat.turn(),
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-prov-1" });
    try {
      await harness.sendChannelEvent({
        event: { text: "hello there", threadId: "t-prov", userId: "U42" },
        deliveryId: "dlv_prov_1",
        externalDeliveryId: "evt_prov_1",
      });

      const puts = storage.changesets.flatMap((c) =>
        c.changeset.changes.flatMap((ch) =>
          ch.op === "put" ? [{ ctx: c.ctx, message: ch.message }] : []
        )
      );
      const userPut = puts.find((p) => p.message.role === "user");
      expect(userPut).toBeDefined();
      expect(userPut!.message.metadata).toMatchObject({
        source: "channel",
        connectorId: channel.id,
        provider: "custom",
        deliveryId: "dlv_prov_1",
        externalDeliveryId: "evt_prov_1",
        externalUserId: "U42",
      });
      expect(userPut!.ctx.source).toBe("channel");
      expect(userPut!.ctx.connectorId).toBe(channel.id);
      expect(userPut!.ctx.trigger).toBe("submit-message");

      const state = storage.transcript("chan-prov-1")?.state as
        | { channelBinding?: { connectorId: string; handle: unknown; deliveryId: string } }
        | null
        | undefined;
      expect(state?.channelBinding).toMatchObject({
        connectorId: channel.id,
        handle: { threadId: "t-prov" },
        deliveryId: "dlv_prov_1",
      });

      const before = storage.changesets.length;
      await harness.sendWebhookAction({ type: "ping", event: { n: 1 } });
      const after = storage.changesets.slice(before);
      expect(after.some((c) => c.ctx.source === "webhook" && c.ctx.trigger === "action-turn")).toBe(
        true
      );
      expect(after.every((c) => c.ctx.source === "webhook")).toBe(true);
    } finally {
      __setTranscriptStorageForTests(undefined);
      await harness.close();
    }
  });
});

describe("chat.agent channel stream errors", () => {
  it("posts the connector's error line, not the error, and marks the turn with the error reaction", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "error", error: new Error("model exploded") },
          ] as LanguageModelV3StreamPart[],
        }),
      }),
    });

    const channel = recordingChannelConnector({
      reactions: { working: "eyes", done: "white_check_mark", error: "warning" },
    });
    const agent = chat.agent({
      id: "chatChannels.stream-error",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-stream-error" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "t-err" } });
      const finals = channel.sent.filter((s) => s.ctx.final);
      expect(finals).toHaveLength(1);
      expect(finals[0]!.message.text).toBe(CHANNEL_TURN_ERROR_MESSAGE);
      expect(finals[0]!.ctx.previousRef).toBe(channel.acks[0]!.ref);
      const names = channel.reactionsApplied.map(
        (r) => `${r.reaction.remove ? "-" : "+"}${r.reaction.name}`
      );
      expect(names).toEqual(["+eyes", "-eyes", "+warning"]);
    } finally {
      await harness.close();
    }
  });

  it("gives a custom outbound() the stream error on its first call", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "error", error: new Error("model exploded") },
          ] as LanguageModelV3StreamPart[],
        }),
      }),
    });
    const channel = recordingChannelConnector();
    (channel as { outbound?: (reply: { text: string; error?: unknown }) => unknown }).outbound = (
      reply
    ) =>
      reply.error
        ? { text: `Failed: ${(reply.error as Error).message}` }
        : { text: reply.text || "(no reply)" };
    const agent = chat.agent({
      id: "chatChannels.stream-error-custom-outbound",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-stream-error-custom" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "t-err-custom" } });
      expect(channel.finalText()).toBe("Failed: model exploded");
    } finally {
      await harness.close();
    }
  });
});

describe("chat.agent channel error line", () => {
  it("ends a reply that failed partway with the error line after the partial text", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Checking the issue..." },
            { type: "error", error: new Error("model exploded") },
          ] as LanguageModelV3StreamPart[],
        }),
      }),
    });
    const channel = recordingChannelConnector();
    (channel as { errorMessage?: string }).errorMessage = "The assistant couldn't finish that.";
    const agent = chat.agent({
      id: "chatChannels.error-line-partial",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-error-partial" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "t-err-partial" } });
      expect(channel.finalText()).toBe(
        "Checking the issue...\n\nThe assistant couldn't finish that."
      );
    } finally {
      await harness.close();
    }
  });

  it("uses the connector's own errorMessage for a failed turn", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "error", error: new Error("model exploded") },
          ] as LanguageModelV3StreamPart[],
        }),
      }),
    });
    const channel = recordingChannelConnector();
    (channel as { errorMessage?: string }).errorMessage = "The assistant couldn't answer that.";
    const agent = chat.agent({
      id: "chatChannels.error-line-override",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-error-line" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "t-err-line" } });
      expect(channel.finalText()).toBe("The assistant couldn't answer that.");
    } finally {
      await harness.close();
    }
  });

  it("builds the line from the failure when errorMessage is a function", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Checking the issue..." },
            { type: "error", error: new Error("rate limited") },
          ] as LanguageModelV3StreamPart[],
        }),
      }),
    });
    const seen: ChannelErrorContext[] = [];
    const channel = recordingChannelConnector();
    (channel as { errorMessage?: ChannelErrorMessage }).errorMessage = async (ctx) => {
      seen.push(ctx);
      return `${ctx.defaultMessage} (${ctx.error.message})`;
    };
    const agent = chat.agent({
      id: "chatChannels.error-line-function",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-error-fn" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "t-err-fn" } });
      expect(channel.finalText()).toBe(
        `Checking the issue...\n\n${CHANNEL_TURN_ERROR_MESSAGE} (rate limited)`
      );
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        partialText: "Checking the issue...",
        event: { text: "hi", threadId: "t-err-fn" },
        chatId: "chan-error-fn",
        defaultMessage: CHANNEL_TURN_ERROR_MESSAGE,
      });
      expect(typeof seen[0]!.runId).toBe("string");
    } finally {
      await harness.close();
    }
  });

  it("passes the model's own error, not a copy, to the errorMessage function", async () => {
    class RateLimitError extends Error {
      override name = "RateLimitError";
    }
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "error", error: new RateLimitError("slow down") },
          ] as LanguageModelV3StreamPart[],
        }),
      }),
    });
    const seen: Error[] = [];
    const channel = recordingChannelConnector();
    (channel as { errorMessage?: ChannelErrorMessage }).errorMessage = ({ error }) => {
      seen.push(error);
      return error.name === "RateLimitError" ? "Busy, try again in a minute." : undefined;
    };
    const agent = chat.agent({
      id: "chatChannels.error-line-function-original",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-error-fn-original" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "t-err-fn-original" } });
      expect(channel.finalText()).toBe("Busy, try again in a minute.");
      expect(seen[0]).toBeInstanceOf(RateLimitError);
    } finally {
      await harness.close();
    }
  });

  it("passes a thrown turn's error to the errorMessage function", async () => {
    const channel = recordingChannelConnector();
    (channel as { errorMessage?: ChannelErrorMessage }).errorMessage = ({ error, partialText }) =>
      `Failed: ${error.message}${partialText ? " after a partial answer" : ""}`;
    const agent = chat.agent({
      id: "chatChannels.error-line-function-thrown",
      channels: [channel],
      run: async () => {
        throw new Error("turn exploded");
      },
    });

    const harness = mockChatAgent(agent, { chatId: "chan-error-fn-thrown" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "t-err-fn-thrown" } });
      expect(channel.finalText()).toBe("Failed: turn exploded");
    } finally {
      await harness.close();
    }
  });

  it.each([
    ["returns nothing", () => undefined],
    [
      "throws",
      () => {
        throw new Error("bad formatter");
      },
    ],
  ])("falls back to the default line when the errorMessage function %s", async (_, fn) => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "error", error: new Error("model exploded") },
          ] as LanguageModelV3StreamPart[],
        }),
      }),
    });
    const channel = recordingChannelConnector();
    (channel as { errorMessage?: ChannelErrorMessage }).errorMessage = fn;
    const agent = chat.agent({
      id: "chatChannels.error-line-function-fallback",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-error-fn-fallback" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "t-err-fn-fallback" } });
      expect(channel.finalText()).toBe(CHANNEL_TURN_ERROR_MESSAGE);
    } finally {
      await harness.close();
    }
  });
});

describe("chat.agent channel final reply delivery", () => {
  function failFinalSends(channel: object, times: number) {
    const target = channel as unknown as {
      send: (message: unknown, ctx: { final?: boolean }) => Promise<unknown>;
    };
    const send = target.send;
    let attempts = 0;
    target.send = async (message, ctx) => {
      if (ctx.final && attempts++ < times) throw new Error("provider unavailable");
      return send(message, ctx);
    };
    return () => attempts;
  }

  it("retries a final reply whose send fails, and marks the turn done once it lands", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("eventually") }),
    });
    const channel = recordingChannelConnector({
      reactions: { working: "eyes", done: "white_check_mark", error: "warning" },
    });
    const attempts = failFinalSends(channel, 2);
    const agent = chat.agent({
      id: "chatChannels.final-send-retry",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-final-send-retry" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "t-retry" } });
      expect(attempts()).toBe(3);
      expect(channel.finalText()).toBe("eventually");
      expect(channel.reactionsApplied.map((r) => r.reaction.name).at(-1)).toBe("white_check_mark");
    } finally {
      await harness.close();
    }
  });

  it("posts a final reply with no placeholder once, even when the send rejects after posting", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("posted once") }),
    });
    const channel = recordingChannelConnector({
      ack: null,
      reactions: { working: "eyes", done: "white_check_mark", error: "warning" },
    });
    const target = channel as unknown as {
      send: (message: unknown, ctx: { final?: boolean }) => Promise<unknown>;
    };
    const send = target.send;
    target.send = async (message, ctx) => {
      const result = await send(message, ctx);
      if (ctx.final) throw new Error("timed out after posting");
      return result;
    };
    const agent = chat.agent({
      id: "chatChannels.final-post-ambiguous",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-final-post-ambiguous" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "t-ambiguous" } });
      expect(channel.sent.filter((sent) => sent.ctx.final)).toHaveLength(1);
      expect(channel.reactionsApplied.map((r) => r.reaction.name).at(-1)).toBe("warning");
    } finally {
      await harness.close();
    }
  });

  it("marks the turn with the error reaction when the final reply can't be sent", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("never lands") }),
    });
    const channel = recordingChannelConnector({
      reactions: { working: "eyes", done: "white_check_mark", error: "warning" },
    });
    const attempts = failFinalSends(channel, Number.POSITIVE_INFINITY);
    const agent = chat.agent({
      id: "chatChannels.final-send-fails",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-final-send-fails" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "t-fails" } });
      expect(attempts()).toBe(3);
      expect(channel.finalText()).toBeUndefined();
      expect(channel.reactionsApplied.map((r) => r.reaction.name).at(-1)).toBe("warning");
    } finally {
      await harness.close();
    }
  });
});

describe("chat.agent channel seeding", () => {
  it("seeds a new session from the connector's prior messages once, with provenance", async () => {
    const seenLastUser: string[] = [];
    const seenCounts: number[] = [];
    const model = new MockLanguageModelV3({
      doStream: async ({ prompt }) => {
        seenCounts.push(prompt.length);
        return { stream: textStream("got it") };
      },
    });
    const storage = memoryTranscriptStorage();
    __setTranscriptStorageForTests(storage);
    const channel = recordingChannelConnector({
      seed: () => [
        {
          role: "user",
          text: "<@U1>: please refund order 789",
          externalMessageId: "1.000",
          externalUserId: "U1",
        },
        {
          role: "assistant",
          text: "The refund for order 789 is complete.",
          externalMessageId: "3.000",
        },
      ],
    });
    const agent = chat.agent({
      id: "chatChannels.seed",
      channels: [channel],
      run: async ({ messages, signal }) => {
        const last = messages[messages.length - 1];
        seenLastUser.push(
          typeof last?.content === "string" ? last.content : JSON.stringify(last?.content)
        );
        return streamText({ model, messages, abortSignal: signal });
      },
    });
    const harness = mockChatAgent(agent, { chatId: "chan-seed-1" });
    try {
      await harness.sendChannelEvent({
        event: { text: "it never arrived", threadId: "chan-seed-1", userId: "U1" },
        deliveryId: "dlv_seed",
      });
      expect(channel.seeded).toHaveLength(1);
      // The model saw the two seeded messages plus the triggering one.
      expect(seenCounts[0]).toBe(3);
      expect(channel.finalText()).toBe("got it");

      const entries = storage.transcript("chan-seed-1")?.entries ?? [];
      const seededEntries = entries.filter(
        (e) => (e.message.metadata as { seeded?: boolean } | undefined)?.seeded
      );
      expect(seededEntries.map((e) => e.message.id)).toEqual(["seed-1.000", "seed-3.000"]);
      expect(seededEntries[0]!.message.metadata).toMatchObject({
        source: "channel",
        connectorId: channel.id,
        deliveryId: "dlv_seed",
        externalUserId: "U1",
        seeded: true,
      });

      // A second turn on the same session does not seed again.
      await harness.sendChannelEvent({ event: { text: "any update?", threadId: "chan-seed-1" } });
      expect(channel.seeded).toHaveLength(1);
      expect(seenCounts[1]).toBe(5);
    } finally {
      __setTranscriptStorageForTests(undefined);
      await harness.close();
    }
  });

  it("starts empty and still answers when seed() throws", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("hello") }),
    });
    const channel = recordingChannelConnector({
      seed: () => {
        throw new Error("slack down");
      },
    });
    const agent = chat.agent({
      id: "chatChannels.seed-fails",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "chan-seed-2" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "chan-seed-2" } });
      expect(channel.finalText()).toBe("hello");
    } finally {
      await harness.close();
    }
  });
});

describe("chat.agent channel interactions", () => {
  it("resumes a pending tool from an interaction callback and finalizes the controls", async () => {
    const TC = "tc_approve_1";
    const requestApproval = tool({
      description: "Request human approval before acting.",
      inputSchema: z.object({ action: z.string() }),
    });

    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream:
          call++ === 0
            ? toolCallStream(TC, "requestApproval", { action: "refund" })
            : textStream("refund issued"),
      }),
    });

    const channel = recordingChannelConnector<{ text?: string; callback?: boolean }>({
      renderInteraction: (pending) => ({
        text: `Approve ${(pending[0]!.input as { action: string }).action}?`,
      }),
      onInteraction: (event) =>
        event?.callback ? { toolCallId: TC, output: { approved: true } } : null,
    });

    const agent = chat.agent({
      id: "chatChannels.hitl-resolve",
      channels: [channel],
      run: async ({ messages, signal }) =>
        streamText({ model, messages, tools: { requestApproval }, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-hitl-1" });
    try {
      await harness.sendChannelEvent({ event: { text: "please refund", threadId: "chan-hitl-1" } });
      expect(channel.finalText()).toBe("Approve refund?");
      expect(channel.finalized).toHaveLength(0);

      await harness.sendChannelEvent({ event: { callback: true } });
      expect(channel.finalized).toHaveLength(1);
      expect(channel.finalText()).toBe("refund issued");
    } finally {
      await harness.close();
    }
  });

  it("resolves an interaction that names the tool instead of the call id", async () => {
    const TC = "tc_by_name_1";
    const requestApproval = tool({
      description: "Request human approval before acting.",
      inputSchema: z.object({ action: z.string() }),
    });
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream:
          call++ === 0
            ? toolCallStream(TC, "requestApproval", { action: "credit" })
            : textStream("credit issued"),
      }),
    });
    const channel = recordingChannelConnector<{ text?: string; answer?: string }>({
      renderInteraction: () => ({ text: "Approve requestApproval?" }),
      onInteraction: (event) =>
        event?.answer === "Approve requestApproval"
          ? { toolName: "requestApproval", output: { approved: true } }
          : null,
    });
    const agent = chat.agent({
      id: "chatChannels.hitl-by-name",
      channels: [channel],
      run: async ({ messages, signal }) =>
        streamText({ model, messages, tools: { requestApproval }, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "chan-hitl-name" });
    try {
      await harness.sendChannelEvent({
        event: { text: "credit them", threadId: "chan-hitl-name" },
      });
      expect(channel.finalText()).toBe("Approve requestApproval?");
      await harness.sendChannelEvent({ event: { answer: "Approve requestApproval" } });
      expect(channel.finalized).toHaveLength(1);
      expect(channel.finalized[0]!.resolution.toolCallId).toBe(TC);
      expect(channel.finalText()).toBe("credit issued");
    } finally {
      await harness.close();
    }
  });

  it("does not repost controls for a still-pending call when one of two approvals resolves, and posts the final text", async () => {
    const A = "tc_multi_a";
    const B = "tc_multi_b";
    const requestApproval = tool({
      description: "Request human approval before acting.",
      inputSchema: z.object({ action: z.string() }),
    });

    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++;
        if (call === 1) {
          // Two approvals requested in one turn.
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "tool-input-start", id: A, toolName: "requestApproval" },
                {
                  type: "tool-input-delta",
                  id: A,
                  delta: JSON.stringify({ action: "refund 111" }),
                },
                { type: "tool-input-end", id: A },
                {
                  type: "tool-call",
                  toolCallId: A,
                  toolName: "requestApproval",
                  input: JSON.stringify({ action: "refund 111" }),
                },
                { type: "tool-input-start", id: B, toolName: "requestApproval" },
                {
                  type: "tool-input-delta",
                  id: B,
                  delta: JSON.stringify({ action: "refund 222" }),
                },
                { type: "tool-input-end", id: B },
                {
                  type: "tool-call",
                  toolCallId: B,
                  toolName: "requestApproval",
                  input: JSON.stringify({ action: "refund 222" }),
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                  usage: {
                    inputTokens: {
                      total: 10,
                      noCache: 10,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: { total: 10, text: 0, reasoning: undefined },
                  },
                },
              ] as LanguageModelV3StreamPart[],
            }),
          };
        }
        return {
          stream: textStream(
            call === 2 ? "111 approved, waiting on 222" : "111 done, 222 declined"
          ),
        };
      },
    });

    const rendered: string[][] = [];
    const channel = recordingChannelConnector<{
      text?: string;
      resolve?: { id: string; approved: boolean };
    }>({
      renderInteraction: (pending) => {
        rendered.push(pending.map((p) => p.toolCallId));
        return {
          text: `Approve ${pending.map((p) => (p.input as { action: string }).action).join(" and ")}?`,
        };
      },
      onInteraction: (event) =>
        event?.resolve
          ? { toolCallId: event.resolve.id, output: { approved: event.resolve.approved } }
          : null,
    });

    const agent = chat.agent({
      id: "chatChannels.hitl-multi",
      channels: [channel],
      run: async ({ messages, signal }) =>
        streamText({ model, messages, tools: { requestApproval }, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-hitl-multi" });
    try {
      await harness.sendChannelEvent({
        event: { text: "refund 111 and 222", threadId: "chan-hitl-multi" },
      });
      expect(rendered).toEqual([[A, B]]);
      expect(channel.finalText()).toBe("Approve refund 111 and refund 222?");

      // Resolve only A. B is still pending in the response; its controls are already posted, so the
      // reply text must post instead of a second controls message.
      await harness.sendChannelEvent({ event: { resolve: { id: A, approved: true } } });
      expect(rendered).toEqual([[A, B]]);
      expect(channel.finalText()).toBe("111 approved, waiting on 222");

      await harness.sendChannelEvent({ event: { resolve: { id: B, approved: false } } });
      expect(rendered).toEqual([[A, B]]);
      expect(channel.finalText()).toBe("111 done, 222 declined");
      expect(channel.finalized).toHaveLength(2);

      // A second click on the decided call is stale: no finalize, no turn, no new post.
      const sendsBefore = channel.sent.length;
      await harness.deliverChannelEvent({ event: { resolve: { id: B, approved: true } } });
      expect(channel.finalized).toHaveLength(2);
      expect(channel.sent).toHaveLength(sendsBefore);
      expect(call).toBe(3);
    } finally {
      await harness.close();
    }
  });

  it("a continuation worker does not repost controls for calls the previous worker already rendered", async () => {
    const A = "tc_cont_a";
    const B = "tc_cont_b";
    const requestApproval = tool({
      description: "Request human approval before acting.",
      inputSchema: z.object({ action: z.string() }),
    });
    const storage = memoryTranscriptStorage();
    __setTranscriptStorageForTests(storage);

    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++;
        if (call === 1) {
          return {
            stream: simulateReadableStream({
              chunks: [
                { type: "tool-input-start", id: A, toolName: "requestApproval" },
                { type: "tool-input-delta", id: A, delta: JSON.stringify({ action: "refund 1" }) },
                { type: "tool-input-end", id: A },
                {
                  type: "tool-call",
                  toolCallId: A,
                  toolName: "requestApproval",
                  input: JSON.stringify({ action: "refund 1" }),
                },
                { type: "tool-input-start", id: B, toolName: "requestApproval" },
                { type: "tool-input-delta", id: B, delta: JSON.stringify({ action: "refund 2" }) },
                { type: "tool-input-end", id: B },
                {
                  type: "tool-call",
                  toolCallId: B,
                  toolName: "requestApproval",
                  input: JSON.stringify({ action: "refund 2" }),
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool_calls" },
                  usage: {
                    inputTokens: {
                      total: 10,
                      noCache: 10,
                      cacheRead: undefined,
                      cacheWrite: undefined,
                    },
                    outputTokens: { total: 10, text: 0, reasoning: undefined },
                  },
                },
              ] as LanguageModelV3StreamPart[],
            }),
          };
        }
        return { stream: textStream("1 approved, waiting on 2") };
      },
    });

    const rendered: string[][] = [];
    const channel = recordingChannelConnector<{
      text?: string;
      resolve?: { id: string; approved: boolean };
    }>({
      renderInteraction: (pending) => {
        rendered.push(pending.map((p) => p.toolCallId));
        return { text: `Approve ${pending.length} actions?` };
      },
      onInteraction: (event) =>
        event?.resolve
          ? { toolCallId: event.resolve.id, output: { approved: event.resolve.approved } }
          : null,
    });

    const agent = chat.agent({
      id: "chatChannels.hitl-continuation",
      channels: [channel],
      run: async ({ messages, signal }) =>
        streamText({ model, messages, tools: { requestApproval }, abortSignal: signal }),
    });

    const first = mockChatAgent(agent, { chatId: "chan-hitl-cont" });
    try {
      await first.sendChannelEvent({
        event: { text: "refund 1 and 2", threadId: "chan-hitl-cont" },
      });
      expect(rendered).toEqual([[A, B]]);
      expect(channel.finalText()).toBe("Approve 2 actions?");
    } finally {
      await first.close();
    }

    const second = mockChatAgent(agent, {
      chatId: "chan-hitl-cont",
      continuation: true,
      previousRunId: "run_first",
    });
    try {
      await second.sendChannelEvent({ event: { resolve: { id: A, approved: true } } });
      expect(rendered).toEqual([[A, B]]);
      expect(channel.finalText()).toBe("1 approved, waiting on 2");
      expect(call).toBe(2);
    } finally {
      __setTranscriptStorageForTests(undefined);
      await second.close();
    }
  });

  it("posts the text written before a pending tool call, then the controls as their own message", async () => {
    const TC = "tc_preamble";
    const requestApproval = tool({
      description: "Request human approval before acting.",
      inputSchema: z.object({ action: z.string() }),
    });
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            {
              type: "text-delta",
              id: "t1",
              delta: "Summary: the refund never landed. Steps: 1) check the processor.",
            },
            { type: "text-end", id: "t1" },
            { type: "tool-input-start", id: TC, toolName: "requestApproval" },
            { type: "tool-input-delta", id: TC, delta: JSON.stringify({ action: "credit" }) },
            { type: "tool-input-end", id: TC },
            {
              type: "tool-call",
              toolCallId: TC,
              toolName: "requestApproval",
              input: JSON.stringify({ action: "credit" }),
            },
            {
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              usage: {
                inputTokens: {
                  total: 10,
                  noCache: 10,
                  cacheRead: undefined,
                  cacheWrite: undefined,
                },
                outputTokens: { total: 10, text: 10, reasoning: undefined },
              },
            },
          ] as LanguageModelV3StreamPart[],
        }),
      }),
    });
    const pendingFlags: Array<boolean | undefined> = [];
    const channel = recordingChannelConnector<{ text?: string }>({
      renderInteraction: () => ({ text: "Approve credit?" }),
      outbound: (reply) => {
        pendingFlags.push(reply.pending);
        return reply.text ? { text: reply.text } : null;
      },
    });
    const agent = chat.agent({
      id: "chatChannels.hitl-preamble",
      channels: [channel],
      run: async ({ messages, signal }) =>
        streamText({ model, messages, tools: { requestApproval }, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "chan-hitl-preamble" });
    try {
      await harness.sendChannelEvent({
        event: { text: "trace the refund and request a credit", threadId: "chan-hitl-preamble" },
      });
      const finals = channel.sent.filter((s) => s.ctx.final);
      expect(finals.map((s) => s.message.text)).toEqual([
        "Summary: the refund never landed. Steps: 1) check the processor.",
        "Approve credit?",
      ]);
      // The text edits the placeholder; the controls are a fresh message.
      expect(finals[0]!.ctx.previousRef).toBe(channel.acks[0]!.ref);
      expect(finals[1]!.ctx.previousRef).toBeUndefined();
      expect(pendingFlags).toEqual([true]);
    } finally {
      await harness.close();
    }
  });

  it("drops a stale interaction callback and runs no turn", async () => {
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return { stream: textStream("should not run") };
      },
    });

    const interactionEvents: unknown[] = [];
    const channel = recordingChannelConnector<{ text?: string; callback?: boolean }>({
      onInteraction: (event) => {
        interactionEvents.push(event);
        return event?.callback ? { toolCallId: "does-not-exist", output: {} } : null;
      },
    });

    const agent = chat.agent({
      id: "chatChannels.hitl-stale",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-hitl-2" });
    try {
      await harness.deliverChannelEvent({ event: { callback: true } });

      expect(interactionEvents).toHaveLength(1);
      expect(modelCalls).toBe(0);
      expect(channel.sent).toHaveLength(0);
      expect(channel.finalized).toHaveLength(0);
    } finally {
      await harness.close();
    }
  });

  it("drops a delivery whose inbound message is empty, such as another app's button click, and runs no turn", async () => {
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls += 1;
        return { stream: textStream("answered") };
      },
    });

    const channel = recordingChannelConnector<{
      text?: string;
      type?: string;
      actions?: { action_id: string }[];
    }>({
      onInteraction: () => null,
    });

    const agent = chat.agent({
      id: "chatChannels.foreign-click",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-foreign-click" });
    try {
      await harness.deliverChannelEvent({
        event: { type: "block_actions", actions: [{ action_id: "moji_pick_1" }] },
      });

      expect(modelCalls).toBe(0);
      expect(channel.acks).toHaveLength(0);
      expect(channel.sent).toHaveLength(0);

      await harness.sendChannelEvent({ event: { text: "still here?" } });
      expect(modelCalls).toBe(1);
      expect(channel.finalText()).toBe("answered");
    } finally {
      await harness.close();
    }
  });

  it("runs a turn for a channel message that carries only a file", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("got the file") }),
    });

    const channel = recordingChannelConnector<{ url?: string }>({
      inbound: (event) => ({
        message: {
          id: "file-only",
          role: "user",
          parts: [{ type: "file", mediaType: "image/png", url: event.url! }],
        },
      }),
    });

    const agent = chat.agent({
      id: "chatChannels.file-only",
      channels: [channel],
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-file-only" });
    try {
      await harness.sendChannelEvent({ event: { url: "data:image/png;base64,iVBORw0KGgo=" } });
      expect(channel.finalText()).toBe("got the file");
    } finally {
      await harness.close();
    }
  });
});

describe("chat.agent channel files", () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  function fileEvent(url: string) {
    return {
      text: "what is in this picture?",
      threadId: "thread-files",
      url,
    };
  }

  function fileChannel(
    download: (url: URL, ctx: { handle?: unknown }) => Promise<any>,
    id?: string
  ) {
    return recordingChannelConnector<{ text: string; threadId: string; url: string }>({
      ...(id ? { id } : {}),
      inbound: (event) => ({
        message: {
          id: "",
          role: "user",
          parts: [
            { type: "text", text: event.text },
            ...(event.url
              ? [
                  {
                    type: "file" as const,
                    mediaType: "image/png",
                    url: event.url,
                    filename: "chart.png",
                  },
                ]
              : []),
          ],
        },
      }),
      download,
    });
  }

  function promptParts(prompt: unknown) {
    return (prompt as { role: string; content: unknown }[])
      .filter((m) => m.role === "user")
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  }

  it("downloads a channel-owned file through the connector, once per run, and hands the bytes to the model", async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      supportedUrls: { "image/*": [/^https:\/\//] },
      doStream: async (options) => {
        prompts.push(options.prompt);
        return { stream: textStream("a bar chart") };
      },
    });

    const downloads: { url: string; handle: unknown }[] = [];
    const channel = fileChannel(async (url, ctx) => {
      if (url.host !== "files.example.test") return null;
      downloads.push({ url: url.href, handle: ctx.handle });
      return { data: PNG, mediaType: "image/png" };
    });

    const agent = chat.agent({
      id: "chatChannels.files",
      channels: [channel],
      run: async ({ messages, signal, streamText }) =>
        streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-files" });
    try {
      await harness.sendChannelEvent({ event: fileEvent("https://files.example.test/chart.png") });
      await harness.sendChannelEvent({
        event: { text: "and the colours?", threadId: "thread-files", url: "" },
      });

      const file = promptParts(prompts[0]).find((p: any) => p.type === "file") as any;
      expect(file?.mediaType).toBe("image/png");
      expect(file?.data).toEqual(PNG);
      expect(promptParts(prompts[1]).some((p: any) => p.type === "file")).toBe(true);
      expect(downloads).toEqual([
        { url: "https://files.example.test/chart.png", handle: { threadId: "thread-files" } },
      ]);
      expect(channel.finalText()).toBe("a bar chart");
    } finally {
      await harness.close();
    }
  });

  it("gives the model the downloaded media type for a file part with a wildcard type", async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(options.prompt);
        return { stream: textStream("a chart") };
      },
    });
    const channel = recordingChannelConnector<{ text: string; threadId: string; url: string }>({
      inbound: (event) => ({
        message: {
          id: "",
          role: "user",
          parts: [
            { type: "text", text: event.text },
            { type: "file", mediaType: "image/*", url: event.url, filename: "upload" },
          ],
        },
      }),
      download: async (url) =>
        url.host === "files.example.test" ? { data: PNG, mediaType: "image/png" } : null,
    });
    const agent = chat.agent({
      id: "chatChannels.files-wildcard",
      channels: [channel],
      run: async ({ messages, signal, streamText }) =>
        streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "chan-files-wildcard" });
    try {
      await harness.sendChannelEvent({
        event: { text: "what is this?", threadId: "t", url: "https://files.example.test/u/1" },
      });
      const file = promptParts(prompts[0]).find((p: any) => p.type === "file") as any;
      expect(file?.mediaType).toBe("image/png");
      expect(file?.data).toEqual(PNG);
    } finally {
      await harness.close();
    }
  });

  it("replaces a channel file that cannot be downloaded with a note and still answers", async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(options.prompt);
        return { stream: textStream("no picture, sorry") };
      },
    });

    const channel = fileChannel(async (url) => {
      if (url.host !== "files.example.test") return null;
      throw new Error("file_not_found");
    });

    const agent = chat.agent({
      id: "chatChannels.files-missing",
      channels: [channel],
      run: async ({ messages, signal, streamText }) =>
        streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-files-missing" });
    try {
      await harness.sendChannelEvent({ event: fileEvent("https://files.example.test/gone.png") });

      const parts = promptParts(prompts[0]) as any[];
      expect(parts.some((p) => p.type === "file")).toBe(false);
      expect(parts.map((p) => p.text)).toContain('[Attached file "chart.png" could not be loaded]');
      expect(channel.finalText()).toBe("no picture, sorry");
    } finally {
      await harness.close();
    }
  });
  it("downloads with the connector bound to the session, even when another connector is listed first", async () => {
    const prompts: unknown[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(options.prompt);
        return { stream: textStream("a chart") };
      },
    });
    const calls: { connector: string; handle: unknown }[] = [];
    const workspaceA = recordingChannelConnector<{ text: string; threadId: string; url: string }>({
      id: "workspace-a",
      download: async (url, ctx) => {
        if (url.host !== "files.example.test") return null;
        calls.push({ connector: "workspace-a", handle: ctx.handle });
        throw new Error("404 with workspace A's token");
      },
    });
    const workspaceB = fileChannel(async (url, ctx) => {
      if (url.host !== "files.example.test") return null;
      calls.push({ connector: "workspace-b", handle: ctx.handle });
      return { data: PNG, mediaType: "image/png" };
    }, "workspace-b");
    const agent = chat.agent({
      id: "chatChannels.files-bound-first",
      channels: [workspaceA, workspaceB],
      run: async ({ messages, signal, streamText }) =>
        streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "chan-files-bound-first" });
    try {
      await harness.sendChannelEvent({
        connectorId: "workspace-b",
        event: fileEvent("https://files.example.test/chart.png"),
      });
      const file = promptParts(prompts[0]).find((p: any) => p.type === "file") as any;
      expect(file?.data).toEqual(PNG);
      expect(calls).toEqual([{ connector: "workspace-b", handle: { threadId: "thread-files" } }]);
    } finally {
      await harness.close();
    }
  });

  it("never fetches a private address for a file no connector owns", async () => {
    const fetched: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      fetched.push(String(input instanceof Request ? input.url : input));
      return realFetch(input, init);
    });
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("unreachable") }),
    });
    const channel = fileChannel(async () => null);
    const agent = chat.agent({
      id: "chatChannels.files-private",
      channels: [channel],
      run: async ({ messages, signal, streamText }) =>
        streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "chan-files-private" });
    try {
      await harness
        .sendChannelEvent({ event: fileEvent("http://127.0.0.1:9/private.png") })
        .catch(() => undefined);
      expect(fetched.filter((u) => u.includes("127.0.0.1"))).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
      await harness.close();
    }
  });
});

describe("chat.agent channel steering", () => {
  function gatedAgent(
    id: string,
    shouldInject: ((event: { messages: unknown[] }) => boolean) | null,
    channel: ReturnType<typeof recordingChannelConnector<any>>
  ) {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let toolEntered = false;
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        call++;
        return {
          stream:
            call === 1 ? toolCallStream("c1", "gate", { q: "x" }) : textStream(`ANSWER-${call}`),
        };
      },
    });
    const gateTool = tool({
      description: "blocks until the test opens it",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => {
        toolEntered = true;
        await gate;
        return "ok";
      },
    });
    const agent = chat.agent({
      id,
      channels: [channel],
      ...(shouldInject ? { pendingMessages: { shouldInject } } : {}),
      run: async ({ messages, signal, streamText }) =>
        streamText({
          model,
          messages,
          abortSignal: signal,
          tools: { gate: gateTool },
          stopWhen: stepCountIs(5),
        }),
    });
    return { agent, model, open, entered: () => toolEntered };
  }

  async function until(check: () => boolean, label: string) {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  const promptHas = (model: MockLanguageModelV3, i: number, text: string) =>
    JSON.stringify(model.doStreamCalls[i]?.prompt ?? null).includes(text);

  it("acknowledges a channel message as soon as it arrives mid-turn, then steers it into the running turn", async () => {
    const acks: { event: unknown; handle: unknown }[] = [];
    const channel = recordingChannelConnector<{ text: string; threadId?: string }>({
      received: (ctx) => {
        acks.push({ event: ctx.event, handle: ctx.handle });
      },
    });
    const t = gatedAgent("chatChannels.steer", () => true, channel);
    const harness = mockChatAgent(t.agent, { chatId: "chan-steer" });
    try {
      const first = harness.sendChannelEvent({
        event: { text: "check the queue", threadId: "t1" },
      });
      await until(t.entered, "tool entered");
      await harness.sendPendingChannelEvent({
        event: { text: "STEER-FROM-SLACK", threadId: "t1" },
      });
      await until(() => acks.length === 1, "acknowledged while the tool is still running");
      expect(t.model.doStreamCalls).toHaveLength(1);
      t.open();
      await first;
      await new Promise((r) => setTimeout(r, 150));

      expect(t.model.doStreamCalls).toHaveLength(2);
      expect(promptHas(t.model, 1, "STEER-FROM-SLACK")).toBe(true);
      expect(channel.finalText()).toBe("ANSWER-2");
      expect(acks).toEqual([
        { event: { text: "STEER-FROM-SLACK", threadId: "t1" }, handle: { threadId: "t1" } },
      ]);
    } finally {
      t.open();
      await harness.close();
    }
  });

  it("acknowledges a mid-turn channel message that shouldInject declines, and runs it as its own turn", async () => {
    const offered: unknown[] = [];
    const acks: unknown[] = [];
    const channel = recordingChannelConnector<{ text: string; threadId?: string }>({
      received: (ctx) => {
        acks.push(ctx.event);
      },
    });
    const t = gatedAgent(
      "chatChannels.steer-declined",
      (event) => {
        offered.push(...event.messages);
        return false;
      },
      channel
    );
    const harness = mockChatAgent(t.agent, { chatId: "chan-steer-declined" });
    try {
      const first = harness.sendChannelEvent({
        event: { text: "check the queue", threadId: "t1" },
      });
      await until(t.entered, "tool entered");
      await harness.sendPendingChannelEvent({ event: { text: "NEXT-TURN", threadId: "t1" } });
      t.open();
      await first;
      await until(() => t.model.doStreamCalls.length === 3, "the declined message's own turn");

      expect(offered).toHaveLength(1);
      expect(promptHas(t.model, 1, "NEXT-TURN")).toBe(false);
      expect(promptHas(t.model, 2, "NEXT-TURN")).toBe(true);
      expect(acks).toEqual([{ text: "NEXT-TURN", threadId: "t1" }]);
    } finally {
      t.open();
      await harness.close();
    }
  });

  it("acknowledges a mid-turn channel message without pendingMessages, and answers it next", async () => {
    const acks: unknown[] = [];
    const channel = recordingChannelConnector<{ text: string; threadId?: string }>({
      received: (ctx) => {
        acks.push(ctx.event);
      },
    });
    const t = gatedAgent("chatChannels.receipt-only", null, channel);
    const harness = mockChatAgent(t.agent, { chatId: "chan-receipt-only" });
    try {
      const first = harness.sendChannelEvent({
        event: { text: "check the queue", threadId: "t1" },
      });
      await until(t.entered, "tool entered");
      await harness.sendPendingChannelEvent({ event: { text: "ANSWER-ME-NEXT", threadId: "t1" } });
      await until(() => acks.length === 1, "acknowledged on arrival");
      t.open();
      await first;
      await until(() => t.model.doStreamCalls.length === 3, "the message's own turn");
      expect(promptHas(t.model, 2, "ANSWER-ME-NEXT")).toBe(true);
      expect(acks).toEqual([{ text: "ANSWER-ME-NEXT", threadId: "t1" }]);
    } finally {
      t.open();
      await harness.close();
    }
  });

  it("never offers an approval click for steering", async () => {
    const offered: unknown[] = [];
    const channel = recordingChannelConnector<{
      text?: string;
      threadId?: string;
      callback?: boolean;
    }>({
      onInteraction: (event) => (event?.callback ? { toolCallId: "c-other", output: {} } : null),
    });
    const t = gatedAgent(
      "chatChannels.steer-click",
      (event) => {
        offered.push(...event.messages);
        return true;
      },
      channel
    );
    const harness = mockChatAgent(t.agent, { chatId: "chan-steer-click" });
    try {
      const first = harness.sendChannelEvent({
        event: { text: "check the queue", threadId: "t1" },
      });
      await until(t.entered, "tool entered");
      await harness.sendPendingChannelEvent({ event: { callback: true, threadId: "t1" } });
      t.open();
      await first;
      await new Promise((r) => setTimeout(r, 150));

      expect(offered).toHaveLength(0);
      expect(t.model.doStreamCalls).toHaveLength(2);
    } finally {
      t.open();
      await harness.close();
    }
  });
});

describe("chat.agent channel actions", () => {
  it("runs onAction for a click the connector maps to an action, and chat.turn(message) answers it in the thread", async () => {
    const prompts: unknown[] = [];
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        prompts.push(options.prompt);
        call++;
        return { stream: textStream(`answer-${call}`) };
      },
    });
    const channel = recordingChannelConnector<{
      text?: string;
      threadId?: string;
      click?: { type: string; question: string };
    }>({
      toAction: (event) => event.click ?? null,
    });
    const actions: unknown[] = [];
    const sources: unknown[] = [];
    const agent = chat.agent({
      id: "chatChannels.click-action",
      channels: [channel],
      actionSchema: z.object({ type: z.literal("ask"), question: z.string() }),
      onAction: async ({ action, channel: source }) => {
        actions.push(action);
        sources.push(source);
        return chat.turn(action.question);
      },
      run: async ({ messages, signal, streamText }) =>
        streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-click-action" });
    try {
      await harness.sendChannelEvent({ event: { text: "how do refunds work?", threadId: "t1" } });
      await harness.sendChannelEvent({
        event: { threadId: "t1", click: { type: "ask", question: "EXPLAIN-MORE" } },
        deliveryId: "dlv_click",
      });

      expect(actions).toEqual([{ type: "ask", question: "EXPLAIN-MORE" }]);
      expect(sources).toEqual([
        {
          connectorId: channel.id,
          provider: channel.source,
          event: { threadId: "t1", click: { type: "ask", question: "EXPLAIN-MORE" } },
          deliveryId: "dlv_click",
        },
      ]);
      expect(JSON.stringify(prompts[1])).toContain("EXPLAIN-MORE");
      const last = channel.sent.at(-1)!;
      expect(last.message.markdown ?? last.message.text).toBe("answer-2");
      expect(last.ctx.bound).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("drops a click whose action fails actionSchema without running a turn", async () => {
    let modelCalls = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => {
        modelCalls++;
        return { stream: textStream("answer") };
      },
    });
    const channel = recordingChannelConnector<{
      text?: string;
      threadId?: string;
      click?: unknown;
    }>({
      toAction: (event) => event.click ?? null,
    });
    const actions: unknown[] = [];
    const agent = chat.agent({
      id: "chatChannels.click-action-invalid",
      channels: [channel],
      actionSchema: z.object({ type: z.literal("ask"), question: z.string() }),
      onAction: async ({ action }) => {
        actions.push(action);
        return chat.turn(action.question);
      },
      run: async ({ messages, signal, streamText }) =>
        streamText({ model, messages, abortSignal: signal }),
    });

    const harness = mockChatAgent(agent, { chatId: "chan-click-action-invalid" });
    try {
      await harness.sendChannelEvent({ event: { text: "hi", threadId: "t1" } });
      await harness
        .deliverChannelEvent({ event: { threadId: "t1", click: { type: "nope" } } })
        .catch(() => {});
      await new Promise((r) => setTimeout(r, 100));
      expect(actions).toEqual([]);
      expect(modelCalls).toBe(1);

      await harness.sendChannelEvent({ event: { text: "still there?", threadId: "t1" } });
      expect(modelCalls).toBe(2);
    } finally {
      await harness.close();
    }
  });
});

describe("makeChannelStreamEditor", () => {
  function streamConnector(send: (message: { text: string }) => Promise<{ ref?: string }>) {
    return { delivery: "stream" as const, send } as never;
  }

  it("re-arms the debounce timer so text buffered during an in-flight edit still lands", async () => {
    vi.useFakeTimers();
    try {
      const sends: string[] = [];
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let call = 0;
      const editor = __makeChannelStreamEditorForTests(
        streamConnector(async (message) => {
          sends.push(message.text);
          call += 1;
          if (call === 1) await firstGate;
          return { ref: "r1" };
        }),
        { event: {}, deliveryId: "d1" },
        "r1"
      );

      editor.observe({ type: "text-delta", delta: "a" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sends).toEqual(["a"]);

      editor.observe({ type: "text-delta", delta: "b" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sends).toEqual(["a"]);

      releaseFirst();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sends).toEqual(["a", "ab"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fire a pending edit after stop()", async () => {
    vi.useFakeTimers();
    try {
      const sends: string[] = [];
      const editor = __makeChannelStreamEditorForTests(
        streamConnector(async (message) => {
          sends.push(message.text);
          return { ref: "r1" };
        }),
        { event: {}, deliveryId: "d1" },
        "r1"
      );

      editor.observe({ type: "text-delta", delta: "a" });
      editor.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sends).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("makeChannelStreamTap", () => {
  it("stops the editor when the stream completes (flush)", async () => {
    let stops = 0;
    const tap = __makeChannelStreamTapForTests({
      observe: () => {},
      stop: () => {
        stops += 1;
      },
    });
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: "x" });
        controller.close();
      },
    });
    const reader = source.pipeThrough(tap).getReader();
    let done = false;
    while (!done) {
      done = (await reader.read()).done;
    }
    expect(stops).toBeGreaterThan(0);
  });

  it("stops the editor when the stream is cancelled mid-flight (abort)", async () => {
    let stops = 0;
    const tap = __makeChannelStreamTapForTests({
      observe: () => {},
      stop: () => {
        stops += 1;
      },
    });
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: "text-delta", delta: "x" });
      },
    });
    const reader = source.pipeThrough(tap).getReader();
    await reader.read();
    await reader.cancel("aborted");
    expect(stops).toBeGreaterThan(0);
  });
});

describe("chat.agent channel progress and surface", () => {
  it("reports tool progress from every manual chat.pipe() in one turn, not just the first", async () => {
    const lookupOrder = tool({
      description: "Look up an order.",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => ({ orderId, status: "shipped" }),
    });
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream:
          call++ % 2 === 0
            ? toolCallStream(`tc_multi_${call}`, "lookupOrder", { orderId: `o-${call}` })
            : textStream(`done ${call}`),
      }),
    });
    const channel = recordingChannelConnector({ progress: true });
    const agent = chat.agent({
      id: "chatChannels.progress-multi-pipe",
      channels: [channel],
      run: async ({ messages, signal }) => {
        for (let i = 0; i < 2; i++) {
          await chat.pipe(
            streamText({
              model,
              messages,
              tools: { lookupOrder },
              stopWhen: stepCountIs(2),
              abortSignal: signal,
            })
          );
        }
      },
    });
    const harness = mockChatAgent(agent, { chatId: "chan-progress-multi" });
    try {
      await harness.sendChannelEvent({
        event: { text: "two lookups please", threadId: "chan-progress-multi" },
      });
      const events = channel.progressed.map((p) => p.event.type);
      expect(events).toEqual(["tool-call", "tool-result", "tool-call", "tool-result"]);
    } finally {
      await harness.close();
    }
  });

  it("reports tool progress when run() pipes the stream itself with chat.pipe()", async () => {
    const TC = "tc_progress_manual";
    const lookupOrder = tool({
      description: "Look up an order.",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => ({ orderId, status: "shipped" }),
    });
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream:
          call++ === 0
            ? toolCallStream(TC, "lookupOrder", { orderId: "o-9" })
            : textStream("order o-9 has shipped"),
      }),
    });
    const channel = recordingChannelConnector({ progress: true });
    const agent = chat.agent({
      id: "chatChannels.progress-manual-pipe",
      channels: [channel],
      run: async ({ messages, signal }) => {
        await chat.pipe(
          streamText({
            model,
            messages,
            tools: { lookupOrder },
            stopWhen: stepCountIs(2),
            abortSignal: signal,
          })
        );
      },
    });
    const harness = mockChatAgent(agent, { chatId: "chan-progress-manual" });
    try {
      await harness.sendChannelEvent({
        event: { text: "where is order o-9", threadId: "chan-progress-manual" },
      });
      // A manual pipe leaves the runtime without a response message, so the connector posts no
      // final reply for the turn; the progress hooks are what this path adds.
      expect(channel.progressed.map((p) => p.event)).toEqual([
        { type: "tool-call", toolCallId: TC, toolName: "lookupOrder", input: { orderId: "o-9" } },
        {
          type: "tool-result",
          toolCallId: TC,
          toolName: "lookupOrder",
          output: { orderId: "o-9", status: "shipped" },
        },
      ]);
    } finally {
      await harness.close();
    }
  });

  it("reports each tool call and its result to progress(), in order, with the turn context", async () => {
    const TC = "tc_progress_1";
    const lookupOrder = tool({
      description: "Look up an order.",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => ({ orderId, status: "shipped" }),
    });
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream:
          call++ === 0
            ? toolCallStream(TC, "lookupOrder", { orderId: "o-1" })
            : textStream("order o-1 has shipped"),
      }),
    });
    const channel = recordingChannelConnector({ progress: true });
    const agent = chat.agent({
      id: "chatChannels.progress",
      channels: [channel],
      run: async ({ messages, signal }) =>
        streamText({
          model,
          messages,
          tools: { lookupOrder },
          stopWhen: stepCountIs(2),
          abortSignal: signal,
        }),
    });
    const harness = mockChatAgent(agent, { chatId: "chan-progress" });
    try {
      await harness.sendChannelEvent({
        event: { text: "where is order o-1", threadId: "chan-progress" },
      });
      expect(channel.finalText()).toBe("order o-1 has shipped");
      const events = channel.progressed.map((p) => p.event);
      expect(events).toEqual([
        { type: "tool-call", toolCallId: TC, toolName: "lookupOrder", input: { orderId: "o-1" } },
        {
          type: "tool-result",
          toolCallId: TC,
          toolName: "lookupOrder",
          output: { orderId: "o-1", status: "shipped" },
        },
      ]);
      const ctx = channel.progressed[0]!.ctx;
      expect(ctx.bound).toBe(false);
      expect(ctx.deliveryId).toBeDefined();
      expect((ctx.event as { text: string }).text).toBe("where is order o-1");
      expect(ctx.handle).toEqual({ threadId: "chan-progress" });
    } finally {
      await harness.close();
    }
  });

  it("chat.surface() reaches the turn's channel surface from inside a tool's execute", async () => {
    const TC = "tc_surface_tool";
    const planned: unknown[] = [];
    const updatePlan = tool({
      description: "Update the plan.",
      inputSchema: z.object({ steps: z.array(z.string()) }),
      execute: async ({ steps }) => {
        const surface = chat.surface<ChannelRunSurface<{ plan: (s: string[]) => Promise<void> }>>();
        if (!surface?.plan) return { updated: false };
        await surface.plan(steps);
        return { updated: true };
      },
    });
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream:
          call++ === 0
            ? toolCallStream(TC, "updatePlan", { steps: ["look", "fix"] })
            : textStream("planned and done"),
      }),
    });
    const channel = recordingChannelConnector({
      surface: () => ({ plan: async (steps: string[]) => void planned.push(steps) }),
    });
    const agent = chat.agent({
      id: "chatChannels.surface-from-tool",
      channels: [channel],
      run: async ({ messages, signal }) =>
        streamText({
          model,
          messages,
          tools: { updatePlan },
          stopWhen: stepCountIs(2),
          abortSignal: signal,
        }),
    });
    const harness = mockChatAgent(agent, { chatId: "chan-surface-tool" });
    try {
      await harness.sendChannelEvent({
        event: { text: "plan this", threadId: "chan-surface-tool" },
      });
      expect(planned).toEqual([["look", "fix"]]);
      expect(channel.finalText()).toBe("planned and done");
    } finally {
      await harness.close();
    }
  });

  it("merges the connector's surface() helpers into run({ channel }) alongside react", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("planned") }),
    });
    const planned: Array<{ steps: string[]; handle: unknown }> = [];
    const channel = recordingChannelConnector({
      surface: (ctx) => ({
        plan: async (steps: string[]) => {
          planned.push({ steps, handle: ctx.handle });
        },
      }),
    });
    let sawReact = false;
    const agent = chat.agent({
      id: "chatChannels.surface",
      channels: [channel],
      run: async ({ messages, signal, channel: surface }) => {
        const s = surface as unknown as {
          plan: (steps: string[]) => Promise<void>;
          react: (n: string) => Promise<void>;
        };
        await s.plan(["understand", "fix"]);
        await s.react("eyes");
        sawReact = true;
        return streamText({ model, messages, abortSignal: signal });
      },
    });
    const harness = mockChatAgent(agent, { chatId: "chan-surface" });
    try {
      await harness.sendChannelEvent({ event: { text: "plan it", threadId: "chan-surface" } });
      expect(channel.finalText()).toBe("planned");
      expect(planned).toEqual([
        { steps: ["understand", "fix"], handle: { threadId: "chan-surface" } },
      ]);
      expect(sawReact).toBe(true);
      expect(channel.reactionsApplied.map((r) => r.reaction.name)).toContain("eyes");
    } finally {
      await harness.close();
    }
  });
});

describe("chat.agent channel control", () => {
  function slowTextStream(words: string[]) {
    const chunks: LanguageModelV3StreamPart[] = [
      { type: "text-start", id: "t1" },
      ...words.map((w) => ({ type: "text-delta" as const, id: "t1", delta: w + " " })),
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
    return simulateReadableStream({ chunks, initialDelayInMs: 0, chunkDelayInMs: 300 });
  }
  async function waitFor(check: () => boolean, timeoutMs = 8_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("waitFor timed out");
  }

  it("a stop control from the channel aborts the running turn and is not run as a turn", async () => {
    const model = new MockLanguageModelV3({
      doStream: async () => ({
        stream: slowTextStream(["one", "two", "three", "four", "five", "six", "seven", "eight"]),
      }),
    });
    const stoppedFlags: boolean[] = [];
    const channel = recordingChannelConnector<{ text?: string; control?: "stop" }>({
      inbound: (e) => ({ message: e?.control === "stop" ? "please stop" : (e?.text ?? "") }),
      onControl: (e) =>
        e?.control === "stop" ? { kind: "stop", message: "stopped from test" } : null,
      outbound: (reply) => {
        if (reply.final) stoppedFlags.push(reply.stopped);
        return reply.text ? { text: reply.text } : null;
      },
    });
    let turns = 0;
    const agent = chat.agent({
      id: "chatChannels.control-stop",
      channels: [channel],
      onTurnStart: async () => {
        turns++;
      },
      run: async ({ messages, signal }) => streamText({ model, messages, abortSignal: signal }),
    });
    const harness = mockChatAgent(agent, { chatId: "chan-control" });
    try {
      const firstTurn = harness.sendChannelEvent({
        event: { text: "write a long essay", threadId: "chan-control" },
      });
      await waitFor(
        () =>
          (harness.allChunks as { type?: string }[]).filter((c) => c.type === "text-delta")
            .length >= 2
      );
      await harness.deliverChannelEvent({ event: { control: "stop", threadId: "chan-control" } });
      await firstTurn;

      const text = channel.finalText() ?? "";
      expect(text.startsWith("one two")).toBe(true);
      expect(text).not.toContain("eight");
      expect(stoppedFlags).toEqual([true]);
      // The stop event was consumed by the running turn, not run as its own turn.
      await new Promise((r) => setTimeout(r, 400));
      expect(turns).toBe(1);

      // A stopped session must take the next message as a normal turn.
      await harness.sendChannelEvent({
        event: { text: "now a short answer", threadId: "chan-control" },
      });
      expect(turns).toBe(2);
      const finals = channel.sent.filter((s) => s.ctx.final);
      expect(finals[finals.length - 1]!.message.text.startsWith("one two")).toBe(true);
      expect(stoppedFlags).toEqual([true, false]);
    } finally {
      await harness.close();
    }
  });

  it("a stop control that arrives while idle runs as a normal turn through inbound()", async () => {
    const seen: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: textStream("stopping now") }),
    });
    const channel = recordingChannelConnector<{ text?: string; control?: "stop" }>({
      inbound: (e) => ({ message: e?.control === "stop" ? "please stop" : (e?.text ?? "") }),
      onControl: (e) => (e?.control === "stop" ? { kind: "stop" } : null),
    });
    const agent = chat.agent({
      id: "chatChannels.control-idle",
      channels: [channel],
      run: async ({ messages, signal }) => {
        const last = messages[messages.length - 1];
        const content = last?.content;
        seen.push(
          typeof content === "string"
            ? content
            : (content ?? [])
                .map((p) => (typeof p === "object" && p.type === "text" ? p.text : ""))
                .join("")
        );
        return streamText({ model, messages, abortSignal: signal });
      },
    });
    const harness = mockChatAgent(agent, { chatId: "chan-control-idle" });
    try {
      await harness.sendChannelEvent({ event: { control: "stop", threadId: "chan-control-idle" } });
      expect(seen).toEqual(["please stop"]);
      expect(channel.finalText()).toBe("stopping now");
    } finally {
      await harness.close();
    }
  });
});
