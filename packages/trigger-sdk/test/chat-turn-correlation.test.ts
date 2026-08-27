import { describe, expect, it, vi } from "vitest";
import type { UIMessage } from "ai";
import { TriggerChatTransport, type TriggerChatTransportOptions } from "../src/v3/chat.js";

// A send's `.out` stream must close on the turn that consumed its own appended
// record, not an earlier turn-complete (e.g. a racing undo action). The seq
// comes back from `/in/append`; correlation headers ride the v2 batch wire.

function user(text: string, id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

type BatchRecord = {
  body: string;
  seq_num: number;
  timestamp: number;
  headers?: Array<[string, string]>;
};

function batchResponse(records: BatchRecord[], settled = false): Response {
  const frames = records
    .map((r) => `event: batch\ndata: ${JSON.stringify({ records: [r] })}\n\n`)
    .join("");
  const headers: Record<string, string> = {
    "Content-Type": "text/event-stream",
    "X-Stream-Version": "v2",
  };
  if (settled) headers["X-Session-Settled"] = "true";
  return new Response(frames, {
    status: 200,
    headers,
  });
}

/** A turn-complete control record whose committed `.in` cursor is `inCursor`. */
function turnComplete(seqNum: number, inCursor: number): BatchRecord {
  return {
    body: "",
    seq_num: seqNum,
    timestamp: seqNum,
    headers: [
      ["trigger-control", "turn-complete"],
      ["session-in-event-id", String(inCursor)],
    ],
  };
}

function textDelta(seqNum: number, text: string): BatchRecord {
  return {
    body: JSON.stringify({
      data: { type: "text-delta", id: "t1", delta: text },
      id: `m${seqNum}`,
    }),
    seq_num: seqNum,
    timestamp: seqNum,
    headers: [],
  };
}

function inResponse(seq?: number): Response {
  return new Response(JSON.stringify(seq === undefined ? { ok: true } : { ok: true, seq }), {
    status: 200,
  });
}

async function readDeltas(stream: ReadableStream<unknown>): Promise<string[]> {
  const out: string[] = [];
  const reader = stream.getReader();
  while (true) {
    const next = await reader.read();
    if (next.done) return out;
    const chunk = next.value as { type?: string; delta?: string };
    if (chunk?.type === "text-delta" && typeof chunk.delta === "string") out.push(chunk.delta);
  }
}

function makeTransport(out: Response, inSeq: number | undefined) {
  const options: TriggerChatTransportOptions = {
    task: "test-task",
    accessToken: async () => "tok_test",
    sessions: { c1: { publicAccessToken: "tok_test", isStreaming: false } },
    fetch: async (_url, _init, ctx) => (ctx.endpoint === "in" ? inResponse(inSeq) : out),
  };
  return new TriggerChatTransport(options);
}

async function submit(transport: TriggerChatTransport): Promise<string[]> {
  const stream = await transport.sendMessages({
    trigger: "submit-message",
    chatId: "c1",
    messageId: undefined,
    messages: [user("hi", "u-1")],
    abortSignal: undefined,
  });
  return readDeltas(stream);
}

describe("transport turn correlation", () => {
  it("persists the owned send's input sequence before subscribing", async () => {
    const onSessionChange = vi.fn();
    const transport = new TriggerChatTransport({
      task: "test-task",
      accessToken: async () => "tok_test",
      sessions: { c1: { publicAccessToken: "tok_test", isStreaming: false } },
      onSessionChange,
      fetch: async (_url, _init, ctx) =>
        ctx.endpoint === "in" ? inResponse(5) : batchResponse([turnComplete(10, 5)]),
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "c1",
      messageId: undefined,
      messages: [user("hi", "u-1")],
      abortSignal: undefined,
    });

    expect(onSessionChange).toHaveBeenCalledWith("c1", {
      publicAccessToken: "tok_test",
      lastEventId: undefined,
      activeInputSeq: 5,
      isStreaming: true,
    });
    expect(transport.getSession("c1")?.activeInputSeq).toBe(5);
    await readDeltas(stream);
    expect(transport.getSession("c1")?.activeInputSeq).toBeUndefined();
  });

  it("skips an earlier turn's turn-complete and closes on its own", async () => {
    // Append seq 5; the undo turn's complete (cursor 4) must be skipped.
    const out = batchResponse([turnComplete(10, 4), textDelta(11, "56"), turnComplete(12, 5)]);
    const deltas = await submit(makeTransport(out, 5));
    expect(deltas).toEqual(["56"]);
  });

  it("does not skip when the turn-complete is at the send's own seq", async () => {
    const out = batchResponse([textDelta(10, "56"), turnComplete(11, 5)]);
    const deltas = await submit(makeTransport(out, 5));
    expect(deltas).toEqual(["56"]);
  });

  it("without an append seq, closes on the first turn-complete (legacy webapp)", async () => {
    // No seq => no baseline => old behavior: close on the first turn-complete.
    const out = batchResponse([turnComplete(10, 4), textDelta(11, "56"), turnComplete(12, 5)]);
    const deltas = await submit(makeTransport(out, undefined));
    expect(deltas).toEqual([]);
  });

  it("reuses a hydrated input sequence to skip stale turn-completes after reconnecting", async () => {
    const transport = new TriggerChatTransport({
      task: "test-task",
      accessToken: async () => "tok_test",
      sessions: {
        c1: { publicAccessToken: "tok_test", isStreaming: true, activeInputSeq: 5 },
      },
      fetch: async () =>
        batchResponse([turnComplete(10, 4), textDelta(11, "current"), turnComplete(12, 5)]),
    });

    const stream = await transport.reconnectToStream({ chatId: "c1" });

    expect(stream).not.toBeNull();
    await expect(readDeltas(stream!)).resolves.toEqual(["current"]);
    expect(transport.getSession("c1")?.isStreaming).toBe(false);
    expect(transport.getSession("c1")?.activeInputSeq).toBeUndefined();
  });

  it("does not request a settled peek while reconnecting a known active input", async () => {
    vi.useFakeTimers();
    try {
      const subscribeHeaders: Headers[] = [];
      const transport = new TriggerChatTransport({
        task: "test-task",
        accessToken: async () => "tok_test",
        sessions: {
          c1: { publicAccessToken: "tok_test", isStreaming: true, activeInputSeq: 5 },
        },
        fetch: async (_url, init) => {
          const headers = new Headers(init?.headers);
          subscribeHeaders.push(headers);

          if (subscribeHeaders.length === 1) {
            // Match the server shortcut: a peek sees the previous turn's
            // boundary at the tail and marks this otherwise-normal EOF settled.
            return batchResponse([turnComplete(10, 4)], headers.has("X-Peek-Settled"));
          }

          return batchResponse([textDelta(11, "current"), turnComplete(12, 5)]);
        },
      });

      const stream = await transport.reconnectToStream({ chatId: "c1" });

      expect(stream).not.toBeNull();
      const deltas = readDeltas(stream!);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(deltas).resolves.toEqual(["current"]);
      expect(subscribeHeaders).toHaveLength(2);
      expect(subscribeHeaders[0]?.get("X-Peek-Settled")).toBeNull();
      expect(transport.getSession("c1")?.isStreaming).toBe(false);
      expect(transport.getSession("c1")?.activeInputSeq).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each([5, 6])(
    "accepts a reconnected turn-complete at or after the active input sequence (%i)",
    async (inCursor) => {
      const transport = new TriggerChatTransport({
        task: "test-task",
        accessToken: async () => "tok_test",
        sessions: {
          c1: { publicAccessToken: "tok_test", isStreaming: true, activeInputSeq: 5 },
        },
        fetch: async () => batchResponse([turnComplete(10, inCursor), textDelta(11, "late")]),
      });

      const stream = await transport.reconnectToStream({ chatId: "c1" });

      expect(stream).not.toBeNull();
      await expect(readDeltas(stream!)).resolves.toEqual([]);
      expect(transport.getSession("c1")?.isStreaming).toBe(false);
      expect(transport.getSession("c1")?.activeInputSeq).toBeUndefined();
    }
  );

  it("uses the input sequence for one accepted watch turn only", async () => {
    let outCalls = 0;
    const turnCompleted: number[] = [];
    const transport = new TriggerChatTransport({
      task: "test-task",
      accessToken: async () => "tok_test",
      watch: true,
      sessions: {
        c1: { publicAccessToken: "tok_test", isStreaming: true, activeInputSeq: 5 },
      },
      onEvent: (event) => {
        if (event.type === "turn-completed") turnCompleted.push(Number(event.sessionInEventId));
      },
      fetch: async () => {
        outCalls++;
        return outCalls === 1
          ? batchResponse([
              turnComplete(10, 4),
              textDelta(11, "first"),
              turnComplete(12, 5),
              textDelta(13, "second"),
              turnComplete(14, 4),
            ])
          : batchResponse([], true);
      },
    });

    const stream = await transport.reconnectToStream({ chatId: "c1" });

    expect(stream).not.toBeNull();
    await expect(readDeltas(stream!)).resolves.toEqual(["first", "second"]);
    expect(turnCompleted).toEqual([5, 4]);
    expect(transport.getSession("c1")?.activeInputSeq).toBeUndefined();
  });
});
