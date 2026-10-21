import { mockChatAgent, recordingChannelConnector } from "../src/v3/test/index.js";

import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL_TURN_ERROR_MESSAGE,
  type ChannelErrorContext,
  type ChannelErrorMessage,
  chat,
  __makeChannelStreamEditorForTests,
  __makeChannelStreamTapForTests,
  __setTranscriptStorageForTests,
} from "../src/v3/ai.js";
import { memoryTranscriptStorage } from "../src/v3/transcriptStorage.js";
import { webhooks } from "../src/v3/webhooks.js";
import { simulateReadableStream, streamText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

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

  it("a continuation dispatches an unprocessed channel delivery before a later browser message", async () => {
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
