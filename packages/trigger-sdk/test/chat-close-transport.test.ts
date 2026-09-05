import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  TriggerChatTransport,
  type ChatTransportEvent,
  type TriggerChatTransportOptions,
} from "../src/v3/chat.js";

type BatchRecord = {
  body: string;
  seq_num: number;
  timestamp: number;
  headers: Array<[string, string]>;
};

function user(text: string, id: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function batchResponse(records: BatchRecord[]): Response {
  const frames = records
    .map((r) => `event: batch\ndata: ${JSON.stringify({ records: [r] })}\n\n`)
    .join("");
  return new Response(frames, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "X-Stream-Version": "v2" },
  });
}

function closedAppendResponse(reason: string): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: "Cannot append to a closed session",
      code: "session_closed",
      closedReason: reason,
    }),
    { status: 409, headers: { "Content-Type": "application/json" } }
  );
}

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
    ...overrides,
  });
  return { transport, events };
}

describe("transport closed-session handling", () => {
  it("flips to closed on the terminal session-closed record and stops reconnecting", async () => {
    const { transport, events } = makeTransport({
      fetch: async (_url, _init, ctx) =>
        ctx.endpoint === "in"
          ? new Response(JSON.stringify({ ok: true, seq: 1 }), { status: 200 })
          : batchResponse([
              {
                body: JSON.stringify({
                  data: { type: "text-delta", id: "t1", delta: "bye" },
                  id: "m1",
                }),
                seq_num: 1,
                timestamp: 1,
                headers: [],
              },
              {
                body: "",
                seq_num: 2,
                timestamp: 2,
                headers: [
                  ["trigger-control", "session-closed"],
                  ["session-closed-reason", "budget exhausted"],
                ],
              },
            ]),
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "c1",
      messageId: undefined,
      messages: [user("hi", "u-1")],
      abortSignal: undefined,
    });
    await readAll(stream);

    const closed = events.find((e) => e.type === "session-closed") as
      | Extract<ChatTransportEvent, { type: "session-closed" }>
      | undefined;
    expect(closed).toBeDefined();
    expect(closed?.reason).toBe("budget exhausted");
    expect(closed?.source).toBe("stream");

    expect(transport.sessionStatus("c1")).toBe("closed");
    expect(transport.sessionClosedReason("c1")).toBe("budget exhausted");

    // Terminal: no resume, and no further sends.
    await expect(transport.reconnectToStream({ chatId: "c1" })).resolves.toBeNull();
    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "c1",
        messageId: undefined,
        messages: [user("still there?", "u-2")],
        abortSignal: undefined,
      })
    ).rejects.toThrow(/closed/);
  });

  it("flips to closed on a 409 from .in/append without retrying", async () => {
    let inAppends = 0;
    const { transport, events } = makeTransport({
      fetch: async (_url, _init, ctx) => {
        if (ctx.endpoint === "in") {
          inAppends++;
          return closedAppendResponse("Monthly budget reached");
        }
        return batchResponse([]);
      },
    });

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "c1",
        messageId: undefined,
        messages: [user("hi", "u-1")],
        abortSignal: undefined,
      })
    ).rejects.toMatchObject({ status: 409, code: "session_closed" });

    // One attempt: a closed session is not an auth problem, so the PAT
    // refresh / session-recreate retries must not fire.
    expect(inAppends).toBe(1);
    expect(transport.sessionStatus("c1")).toBe("closed");
    expect(transport.sessionClosedReason("c1")).toBe("Monthly budget reached");

    const closed = events.find((e) => e.type === "session-closed") as
      | Extract<ChatTransportEvent, { type: "session-closed" }>
      | undefined;
    expect(closed?.source).toBe("append");
  });

  it("keeps a hydrated session closed across a reload", async () => {
    const { transport } = makeTransport({
      sessions: {
        c1: {
          publicAccessToken: "tok_test",
          isStreaming: false,
          closed: true,
          closedReason: "Monthly budget reached",
        },
      },
      fetch: async () => {
        throw new Error("a reloaded closed session must not reach the network");
      },
    });

    expect(transport.sessionStatus("c1")).toBe("closed");
    expect(transport.sessionClosedReason("c1")).toBe("Monthly budget reached");
    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "c1",
        messageId: undefined,
        messages: [user("hi", "u-1")],
        abortSignal: undefined,
      })
    ).rejects.toThrow(/closed/);
  });

  it("marks closed when the 409 arrives only after a PAT refresh", async () => {
    let inAppends = 0;
    const { transport, events } = makeTransport({
      accessToken: async () => "tok_refreshed",
      fetch: async (_url, init, ctx) => {
        if (ctx.endpoint !== "in") return batchResponse([]);
        inAppends++;
        // First attempt fails auth, so the transport refreshes the PAT and
        // retries. The retry is the one the server refuses.
        if (inAppends === 1) {
          return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
        }
        return closedAppendResponse("closed during the refresh");
      },
    });

    await expect(
      transport.sendMessages({
        trigger: "submit-message",
        chatId: "c1",
        messageId: undefined,
        messages: [user("hi", "u-1")],
        abortSignal: undefined,
      })
    ).rejects.toMatchObject({ status: 409, code: "session_closed" });

    expect(inAppends).toBe(2);
    expect(transport.sessionStatus("c1")).toBe("closed");
    expect(transport.sessionClosedReason("c1")).toBe("closed during the refresh");
    expect(events.filter((e) => e.type === "session-closed")).toHaveLength(1);
  });
});
