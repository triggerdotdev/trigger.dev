import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  TriggerChatTransport,
  type ChatTransportEvent,
  type TriggerChatTransportOptions,
} from "../src/v3/chat.js";

// ── Helpers ────────────────────────────────────────────────────────────

function user(text: string, id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function jsonOk(): Response {
  return new Response("{}", { status: 200 });
}

/** Build a `text/event-stream` Response from raw SSE text (v1 wire). */
function sseResponse(frames: string): Response {
  return new Response(frames, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** SSE body: one data chunk then a legacy turn-complete control chunk. */
const SSE_ONE_TURN = [
  `id: 1`,
  `data: {"type":"text-delta","id":"t1","delta":"hello"}`,
  ``,
  `id: 2`,
  `data: {"type":"trigger:turn-complete"}`,
  ``,
  ``,
].join("\n");

async function readAll(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) return out;
    out.push(next.value);
  }
}

function makeTransport(overrides: Partial<TriggerChatTransportOptions> = {}) {
  const events: ChatTransportEvent[] = [];
  const transport = new TriggerChatTransport({
    task: "test-task",
    accessToken: async () => "tok_test",
    sessions: { c1: { publicAccessToken: "tok_test", isStreaming: false } },
    onEvent: (event) => events.push(event),
    fetch: async (_url, _init, ctx) =>
      ctx.endpoint === "in" ? jsonOk() : sseResponse(SSE_ONE_TURN),
    ...overrides,
  });
  return { transport, events };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("transport send events", () => {
  it("emits message-sent for a successful submit and the full stream lifecycle", async () => {
    const { transport, events } = makeTransport();

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "c1",
      messageId: undefined,
      messages: [user("hi", "u-1")],
      abortSignal: undefined,
    });
    await readAll(stream);

    const types = events.map((e) => e.type);
    expect(types).toEqual(["message-sent", "stream-connected", "first-chunk", "turn-completed"]);

    const sent = events[0] as Extract<ChatTransportEvent, { type: "message-sent" }>;
    expect(sent.chatId).toBe("c1");
    expect(sent.messageId).toBe("u-1");
    expect(sent.source).toBe("submit-message");
    expect(sent.durationMs).toBeGreaterThanOrEqual(0);
    expect(sent.timestamp).toBeGreaterThan(0);
    expect(sent.partId).toMatch(/[0-9a-f-]{36}/);
    expect(sent.bodyBytes).toBeGreaterThan(0);

    const connected = events[1] as Extract<ChatTransportEvent, { type: "stream-connected" }>;
    expect(connected.resumed).toBe(false);
    expect(connected.messageId).toBe("u-1");

    const firstChunk = events[2] as Extract<ChatTransportEvent, { type: "first-chunk" }>;
    expect(firstChunk.chunkType).toBe("text-delta");
    expect(firstChunk.lastEventId).toBe("1");
    expect(firstChunk.messageId).toBe("u-1");
    expect(firstChunk.sinceSendMs).toBeGreaterThanOrEqual(0);

    const turnCompleted = events[3] as Extract<ChatTransportEvent, { type: "turn-completed" }>;
    expect(turnCompleted.messageId).toBe("u-1");
    expect(turnCompleted.sinceSendMs).toBeGreaterThanOrEqual(0);
    expect(turnCompleted.lastEventId).toBe("2");
  });

  it("emits message-send-failed with the HTTP status when the append fails", async () => {
    const { transport, events } = makeTransport({
      fetch: async () => new Response("too large", { status: 413 }),
    });

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "c1",
        messageId: undefined,
        messages: [user("hi", "u-1")],
        abortSignal: undefined,
      })
    ).rejects.toThrow();

    expect(events).toHaveLength(1);
    const failed = events[0] as Extract<ChatTransportEvent, { type: "message-send-failed" }>;
    expect(failed.type).toBe("message-send-failed");
    expect(failed.source).toBe("submit-message");
    expect(failed.messageId).toBe("u-1");
    expect(failed.status).toBe(413);
    expect(failed.error).toBeInstanceOf(Error);
  });

  it("emits steer events from sendPendingMessage without changing its boolean result", async () => {
    const { transport, events } = makeTransport();
    const ok = await transport.sendPendingMessage("c1", user("steer", "u-2"));
    expect(ok).toBe(true);
    expect(events[0]).toMatchObject({ type: "message-sent", source: "steer", messageId: "u-2" });

    const failing = makeTransport({ fetch: async () => new Response("nope", { status: 500 }) });
    const notOk = await failing.transport.sendPendingMessage("c1", user("steer", "u-3"));
    expect(notOk).toBe(false);
    expect(failing.events[0]).toMatchObject({
      type: "message-send-failed",
      source: "steer",
      status: 500,
    });
  });

  it("emits action and stop send events", async () => {
    const { transport, events } = makeTransport();

    const stream = await transport.sendAction("c1", { type: "undo" });
    await readAll(stream);
    expect(events[0]).toMatchObject({ type: "message-sent", source: "action" });

    events.length = 0;
    const stopped = await transport.stopGeneration("c1");
    expect(stopped).toBe(true);
    expect(events[0]).toMatchObject({ type: "message-sent", source: "stop" });
  });

  it("swallows exceptions thrown by the onEvent callback", async () => {
    const { transport } = makeTransport({
      onEvent: () => {
        throw new Error("observer exploded");
      },
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "c1",
      messageId: undefined,
      messages: [user("hi", "u-1")],
      abortSignal: undefined,
    });
    const chunks = await readAll(stream);
    expect(chunks.length).toBeGreaterThan(0);
  });
});

describe("transport stream events", () => {
  it("marks reconnectToStream subscriptions as resumed", async () => {
    const { transport, events } = makeTransport({
      sessions: {
        c1: { publicAccessToken: "tok_test", isStreaming: true, lastEventId: "1" },
      },
    });

    const stream = await transport.reconnectToStream({ chatId: "c1" });
    expect(stream).not.toBeNull();
    await readAll(stream!);

    const connected = events.find((e) => e.type === "stream-connected") as Extract<
      ChatTransportEvent,
      { type: "stream-connected" }
    >;
    expect(connected.resumed).toBe(true);
    expect(events.some((e) => e.type === "turn-completed")).toBe(true);
  });

  it("re-arms first-chunk per turn on a watch-mode stream", async () => {
    const TWO_TURNS = [
      `id: 1`,
      `data: {"type":"text-delta","id":"t1","delta":"turn one"}`,
      ``,
      `id: 2`,
      `data: {"type":"trigger:turn-complete"}`,
      ``,
      `id: 3`,
      `data: {"type":"text-delta","id":"t2","delta":"turn two"}`,
      ``,
      `id: 4`,
      `data: {"type":"trigger:turn-complete"}`,
      ``,
      ``,
    ].join("\n");

    const { transport, events } = makeTransport({
      watch: true,
      sessions: { c1: { publicAccessToken: "tok_test", isStreaming: true } },
      fetch: async (_url, _init, ctx) =>
        ctx.endpoint === "in" ? jsonOk() : sseResponse(TWO_TURNS),
    });

    const stream = await transport.reconnectToStream({ chatId: "c1" });
    await readAll(stream!);

    expect(events.filter((e) => e.type === "first-chunk")).toHaveLength(2);
    expect(events.filter((e) => e.type === "turn-completed")).toHaveLength(2);
  });

  it("emits the full lifecycle on the headStart first-turn path", async () => {
    const handoverSse = [
      `data: {"type":"start","messageId":"a-1"}`,
      ``,
      `data: {"type":"text-delta","id":"t1","delta":"warm"}`,
      ``,
      `data: {"type":"trigger:turn-complete"}`,
      ``,
      ``,
    ].join("\n");
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(handoverSse, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "X-Trigger-Chat-Access-Token": "tok_handover",
        },
      })) as typeof fetch;

    try {
      const { transport, events } = makeTransport({
        headStart: "/api/chat",
        sessions: {},
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "c-hs",
        messageId: undefined,
        messages: [user("hi", "u-hs")],
        abortSignal: undefined,
      });
      await readAll(stream);

      const types = events.map((e) => e.type);
      expect(types).toEqual(["message-sent", "stream-connected", "first-chunk", "turn-completed"]);
      expect(events[0]).toMatchObject({ source: "head-start", messageId: "u-hs" });
      const firstChunk = events[2] as Extract<ChatTransportEvent, { type: "first-chunk" }>;
      expect(firstChunk.chunkType).toBe("start");
      expect(firstChunk.messageId).toBe("u-hs");
      expect(firstChunk.sinceSendMs).toBeGreaterThanOrEqual(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("emits stream-error when the headStart response body fails mid-read", async () => {
    const encoder = new TextEncoder();
    const failingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {"type":"text-delta","id":"t1","delta":"w"}\n\n`));
        controller.error(new Error("network drop"));
      },
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(failingBody, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "X-Trigger-Chat-Access-Token": "tok_handover",
        },
      })) as typeof fetch;

    try {
      const { transport, events } = makeTransport({ headStart: "/api/chat", sessions: {} });
      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "c-hs-err",
        messageId: undefined,
        messages: [user("hi", "u-hs")],
        abortSignal: undefined,
      });
      await expect(readAll(stream)).rejects.toThrow("network drop");

      const streamError = events.find((e) => e.type === "stream-error");
      expect(streamError).toBeDefined();
      expect(events.some((e) => e.type === "turn-completed")).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("emits stream-error when the output stream fails unrecoverably", async () => {
    const { transport, events } = makeTransport({
      fetch: async (_url, _init, ctx) =>
        ctx.endpoint === "in" ? jsonOk() : new Response("gone", { status: 400 }),
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "c1",
      messageId: undefined,
      messages: [user("hi", "u-1")],
      abortSignal: undefined,
    });
    await expect(readAll(stream)).rejects.toThrow();

    expect(events.some((e) => e.type === "stream-error")).toBe(true);
    expect(events.some((e) => e.type === "stream-connected")).toBe(false);
  });
});
