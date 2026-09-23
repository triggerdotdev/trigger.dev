import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TriggerChatTransport,
  type ChatActionOptions,
  type ChatActionSettlement,
  type TriggerChatTransportOptions,
} from "./chat.js";

type BatchRecord = {
  body: string;
  seq_num: number;
  timestamp: number;
  headers: Array<[string, string]>;
};

function complete(seq: number, cursor?: string): BatchRecord {
  return {
    body: "",
    seq_num: seq,
    timestamp: seq,
    headers: [
      ["trigger-control", "turn-complete"],
      ...(cursor === undefined
        ? []
        : ([["session-in-event-id", cursor]] as Array<[string, string]>)),
    ],
  };
}

function chunk(seq: number, data: UIMessageChunk): BatchRecord {
  return {
    body: JSON.stringify({ data, id: `part-${seq}` }),
    seq_num: seq,
    timestamp: seq,
    headers: [],
  };
}

function frame(records: BatchRecord[]): string {
  return `event: batch\ndata: ${JSON.stringify({ records })}\n\n`;
}

function sse(response: ServerResponse, records: BatchRecord[], end = true): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "X-Stream-Version": "v2",
    "X-Session-Settled": "true",
  });
  response.write(frame(records));
  if (end) response.end();
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return chunks;
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
}

describe("action settlement", () => {
  let server: Server;
  let baseURL: string;
  let appendSeq: unknown;
  let appendStatus: number;
  let inputs: Array<{ kind: string; payload?: { metadata?: Record<string, unknown> } }>;
  let output: (response: ServerResponse) => void;
  let transports: TriggerChatTransport[];

  beforeEach(async () => {
    appendSeq = 5;
    appendStatus = 200;
    inputs = [];
    transports = [];
    output = (response) => sse(response, [complete(11, "5")]);
    server = createServer((request, response) => {
      if (request.method === "GET") {
        output(response);
        return;
      }
      const body: Buffer[] = [];
      request.on("data", (part: Buffer) => body.push(part));
      request.on("end", () => {
        inputs.push(JSON.parse(Buffer.concat(body).toString()));
        response.writeHead(appendStatus, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: appendStatus === 200, seq: appendSeq }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const transport of transports) transport.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function transport(options: Partial<TriggerChatTransportOptions> = {}): TriggerChatTransport {
    const instance = new TriggerChatTransport({
      task: "chat-task",
      accessToken: () => "test-token",
      sessions: { chat: { publicAccessToken: "test-token", isStreaming: false } },
      baseURL,
      ...options,
    });
    transports.push(instance);
    return instance;
  }

  it.each([
    [0, "0"],
    [5, "5"],
    [5, "7"],
    [5, "0005"],
    [Number.MAX_SAFE_INTEGER, String(Number.MAX_SAFE_INTEGER)],
  ])("settles input %s at committed cursor %s", async (inputSeq, cursor) => {
    appendSeq = inputSeq;
    const settlements: ChatActionSettlement[] = [];
    output = (response) => sse(response, [complete(11, cursor)]);
    const stream = await transport().sendAction(
      "chat",
      { type: "edit" },
      {
        onSettled: (settlement) => settlements.push(settlement),
      }
    );
    expect(await drain(stream)).toEqual([]);
    expect(settlements).toEqual([{ inputSeq, sessionInEventId: cursor, lastEventId: "11" }]);
  });

  it("ignores stale completion and preserves the following action response", async () => {
    const delta: UIMessageChunk = { type: "text-delta", id: "text", delta: "updated" };
    output = (response) => sse(response, [complete(9, "4"), chunk(10, delta), complete(11, "5")]);
    const settlements: ChatActionSettlement[] = [];
    const stream = await transport().sendAction(
      "chat",
      {},
      {
        onSettled: (settlement) => settlements.push(settlement),
      }
    );
    expect(await drain(stream)).toEqual([delta]);
    expect(settlements).toEqual([{ inputSeq: 5, sessionInEventId: "5", lastEventId: "11" }]);
  });

  it.each([undefined, null, "5", -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "does not settle an invalid or missing append sequence: %s",
    async (inputSeq) => {
      appendSeq = inputSeq;
      output = (response) => sse(response, [complete(11, String(Number.MAX_SAFE_INTEGER))]);
      const settlements: ChatActionSettlement[] = [];
      const stream = await transport().sendAction(
        "chat",
        {},
        {
          onSettled: (settlement) => settlements.push(settlement),
        }
      );
      await drain(stream);
      expect(settlements).toEqual([]);
    }
  );

  it.each([
    undefined,
    "",
    " ",
    " 5",
    "5 ",
    "5\n",
    "5\r",
    "+5",
    "-5",
    "5.0",
    "5e0",
    "5junk",
    "NaN",
    "9007199254740992",
  ])("does not settle an invalid or missing committed cursor: %s", async (cursor) => {
    output = (response) => sse(response, [complete(11, cursor)]);
    const settlements: ChatActionSettlement[] = [];
    const stream = await transport().sendAction(
      "chat",
      {},
      {
        onSettled: (settlement) => settlements.push(settlement),
      }
    );
    await drain(stream);
    expect(settlements).toEqual([]);
  });

  it("preserves legacy completion without claiming settlement", async () => {
    output = (response) =>
      sse(response, [chunk(11, { type: "trigger:turn-complete" } as unknown as UIMessageChunk)]);
    const settlements: ChatActionSettlement[] = [];
    const stream = await transport().sendAction(
      "chat",
      {},
      {
        onSettled: (settlement) => settlements.push(settlement),
      }
    );
    expect(await drain(stream)).toEqual([]);
    expect(settlements).toEqual([]);
  });

  it("does not confuse settled EOF with correlated completion", async () => {
    output = (response) => sse(response, []);
    const settlements: ChatActionSettlement[] = [];
    const stream = await transport().sendAction(
      "chat",
      {},
      {
        onSettled: (settlement) => settlements.push(settlement),
      }
    );
    expect(await drain(stream)).toEqual([]);
    expect(settlements).toEqual([]);
  });

  it.each(["session-closed", "turn-complete"])(
    "distinguishes %s boundaries from action settlement",
    async (control) => {
      const boundary = complete(11, "5");
      boundary.headers[0] = ["trigger-control", control];
      boundary.headers.push(["session-closed", "true"]);
      output = (response) => sse(response, [boundary]);
      const settlements: ChatActionSettlement[] = [];
      const instance = transport();
      const stream = await instance.sendAction(
        "chat",
        {},
        {
          onSettled: (settlement) => settlements.push(settlement),
        }
      );
      expect(await drain(stream)).toEqual([]);
      expect(instance.getSession("chat")?.closed).toBe(true);
      expect(settlements).toEqual(
        control === "turn-complete"
          ? [{ inputSeq: 5, sessionInEventId: "5", lastEventId: "11" }]
          : []
      );
    }
  );

  it("does not settle when a supersede gate swallowed the action output", async () => {
    const settlements: ChatActionSettlement[] = [];
    const instance = transport({
      sessions: { chat: { publicAccessToken: "test-token", isStreaming: true, activeInputSeq: 4 } },
    });
    expect(await instance.stopGeneration("chat")).toBe(true);
    appendSeq = 6;
    output = (response) => sse(response, [complete(11, "6")]);
    const stream = await instance.sendAction(
      "chat",
      {},
      {
        onSettled: (settlement) => settlements.push(settlement),
      }
    );
    await expect(drain(stream)).rejects.toThrow("The previous turn's output was lost");
    expect(settlements).toEqual([]);
  });

  it("reports consumption even when the action response contains an error", async () => {
    const error: UIMessageChunk = { type: "error", errorText: "Edit was rejected" };
    output = (response) => sse(response, [chunk(10, error), complete(11, "5")]);
    const settlements: ChatActionSettlement[] = [];
    const stream = await transport().sendAction(
      "chat",
      {},
      {
        onSettled: (settlement) => settlements.push(settlement),
      }
    );
    expect(await drain(stream)).toEqual([error]);
    expect(settlements).toHaveLength(1);
  });

  it.each(["append", "stream"])("does not settle on a failed %s request", async (failure) => {
    const settlements: ChatActionSettlement[] = [];
    if (failure === "append") appendStatus = 400;
    else
      output = (response) => {
        response.writeHead(400);
        response.end("Cannot subscribe");
      };
    const action = transport().sendAction(
      "chat",
      {},
      {
        onSettled: (settlement) => settlements.push(settlement),
      }
    );
    if (failure === "append") await expect(action).rejects.toThrow();
    else await expect(drain(await action)).rejects.toThrow();
    expect(settlements).toEqual([]);
  });

  it.each(["abort", "cancel", "dispose", "stop"])(
    "does not settle after %s",
    async (cancellation) => {
      output = (response) =>
        sse(response, [chunk(10, { type: "text-delta", id: "text", delta: "pending" })], false);
      const instance = transport();
      const abort = new AbortController();
      const settlements: ChatActionSettlement[] = [];
      const stream = await instance.sendAction(
        "chat",
        {},
        {
          abortSignal: abort.signal,
          onSettled: (settlement) => settlements.push(settlement),
        }
      );
      const reader = stream.getReader();
      expect((await reader.read()).done).toBe(false);
      if (cancellation === "abort") abort.abort();
      else if (cancellation === "cancel") await reader.cancel();
      else if (cancellation === "dispose") instance.dispose();
      else expect(await instance.stopGeneration("chat")).toBe(true);
      expect((await reader.read()).done).toBe(true);
      reader.releaseLock();
      expect(settlements).toEqual([]);
    }
  );

  it("only settles the replacement when an action supersedes its reader", async () => {
    let subscriptions = 0;
    output = (response) => {
      if (++subscriptions === 1) {
        sse(response, [chunk(10, { type: "text-delta", id: "text", delta: "pending" })], false);
      } else sse(response, [complete(11, "5"), complete(12, "6")]);
    };
    const instance = transport();
    const firstSettlements: ChatActionSettlement[] = [];
    const secondSettlements: ChatActionSettlement[] = [];
    const first = await instance.sendAction(
      "chat",
      {},
      {
        onSettled: (settlement) => firstSettlements.push(settlement),
      }
    );
    const reader = first.getReader();
    await reader.read();
    appendSeq = 6;
    const second = await instance.sendAction(
      "chat",
      {},
      {
        onSettled: (settlement) => secondSettlements.push(settlement),
      }
    );
    await drain(second);
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
    expect(firstSettlements).toEqual([]);
    expect(secondSettlements).toEqual([{ inputSeq: 6, sessionInEventId: "6", lastEventId: "12" }]);
  });

  it.each(["abort", "dispose"])(
    "rechecks %s after the turn-completed observer",
    async (cancellation) => {
      const abort = new AbortController();
      const settlements: ChatActionSettlement[] = [];
      const instance = transport({
        onEvent: (event) => {
          if (event.type !== "turn-completed") return;
          if (cancellation === "abort") abort.abort();
          else instance.dispose();
        },
      });
      const stream = await instance.sendAction(
        "chat",
        {},
        {
          abortSignal: abort.signal,
          onSettled: (settlement) => settlements.push(settlement),
        }
      );
      await drain(stream);
      expect(settlements).toEqual([]);
    }
  );

  it("settles only once while a watch subscription continues across later turns", async () => {
    output = (response) => sse(response, [complete(11, "5"), complete(12, "6"), complete(13, "7")]);
    const settlements: ChatActionSettlement[] = [];
    const stream = await transport({ watch: true }).sendAction(
      "chat",
      {},
      {
        onSettled: (settlement) => settlements.push(settlement),
      }
    );
    await drain(stream);
    expect(settlements).toEqual([{ inputSeq: 5, sessionInEventId: "5", lastEventId: "11" }]);
  });

  it("snapshots the completion cursor before observers mutate event and session state", async () => {
    const settlements: ChatActionSettlement[] = [];
    const instance = transport({
      onEvent: (event) => {
        if (event.type !== "turn-completed") return;
        event.lastEventId = "99";
        event.sessionInEventId = "99";
        instance.setSession("chat", { publicAccessToken: "replacement-token", lastEventId: "99" });
      },
    });
    await drain(
      await instance.sendAction(
        "chat",
        {},
        {
          onSettled: (settlement) => settlements.push(settlement),
        }
      )
    );
    expect(settlements).toEqual([{ inputSeq: 5, sessionInEventId: "5", lastEventId: "11" }]);
  });

  it("contains callback exceptions and finishes persisting the session", async () => {
    const events: string[] = [];
    const instance = transport({ onEvent: (event) => events.push(event.type) });
    const stream = await instance.sendAction(
      "chat",
      {},
      {
        onSettled: () => {
          throw new Error("Observer failed");
        },
      }
    );
    expect(await drain(stream)).toEqual([]);
    expect(instance.getSession("chat")?.isStreaming).toBe(false);
    expect(events).toContain("turn-completed");
    expect(events).not.toContain("stream-error");
  });

  it("preserves the two-argument call and existing per-action metadata", async () => {
    const instance = transport({ clientData: { shared: "default", retained: true } });
    expect(await drain(await instance.sendAction("chat", {}))).toEqual([]);
    const settlements: ChatActionSettlement[] = [];
    const options: ChatActionOptions = {
      metadata: { shared: "action" },
      abortSignal: new AbortController().signal,
      onSettled: (settlement) => settlements.push(settlement),
    };
    expect(await drain(await instance.sendAction("chat", {}, options))).toEqual([]);
    expect(inputs[0]?.payload?.metadata).toEqual({ shared: "default", retained: true });
    expect(inputs[1]?.payload?.metadata).toEqual({ shared: "action", retained: true });
    expect(settlements).toHaveLength(1);
  });
});
