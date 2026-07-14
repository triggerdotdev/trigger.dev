import { describe, expect, it } from "vitest";
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

function batchResponse(records: BatchRecord[]): Response {
  const frames = records
    .map((r) => `event: batch\ndata: ${JSON.stringify({ records: [r] })}\n\n`)
    .join("");
  return new Response(frames, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "X-Stream-Version": "v2" },
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
    body: JSON.stringify({ data: { type: "text-delta", id: "t1", delta: text }, id: "m1" }),
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
});
