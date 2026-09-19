import { createServer, type Server, type ServerResponse } from "node:http";
import { readUIMessageStream, type UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TriggerChatTransport,
  type ChatSessionPersistedState,
  type TriggerChatTransportOptions,
} from "./chat.js";

type OutputRecord = {
  seq_num: number;
  timestamp: number;
  body: string;
  headers: string[][];
};

function chunk(seq: number, data: UIMessageChunk): OutputRecord {
  return {
    seq_num: seq,
    timestamp: seq,
    body: JSON.stringify({ id: `part-${seq}`, data }),
    headers: [],
  };
}

function complete(seq: number, input: number): OutputRecord {
  return {
    seq_num: seq,
    timestamp: seq,
    body: "",
    headers: [
      ["trigger-control", "turn-complete"],
      ["session-in-event-id", String(input)],
    ],
  };
}

function reply(start: number): OutputRecord[] {
  return [
    chunk(start, { type: "start", messageId: "new" }),
    chunk(start + 1, { type: "text-start", id: "text" }),
    chunk(start + 2, { type: "text-delta", id: "text", delta: "New response" }),
    chunk(start + 3, { type: "text-end", id: "text" }),
    chunk(start + 4, { type: "finish" }),
  ];
}

async function readText(stream: ReadableStream<UIMessageChunk>): Promise<string> {
  let text = "";
  for await (const message of readUIMessageStream({ stream, terminateOnError: true })) {
    text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
  }
  return text;
}

describe("Stop with a successor response", () => {
  let server: Server;
  let baseURL: string;
  let transport: TriggerChatTransport;
  let outputs: ServerResponse[];
  let inputSeq: number;
  let holdStop: boolean;
  let stopStatus: number;
  let settled: boolean;
  let includeSequence: boolean;
  let pendingStop: { response: ServerResponse; seq: number } | undefined;
  let saved: ChatSessionPersistedState | null;

  function createTransport(
    session: ChatSessionPersistedState,
    options: Partial<TriggerChatTransportOptions> = {}
  ) {
    return new TriggerChatTransport({
      task: "test-chat",
      baseURL,
      accessToken: () => "test-token",
      sessions: { chat: session },
      onSessionChange: (_chatId, session) => {
        saved = session;
      },
      ...options,
    });
  }

  function appendResponse(response: ServerResponse, seq: number, status = 200) {
    response
      .writeHead(status, { "Content-Type": "application/json" })
      .end(JSON.stringify(includeSequence ? { seq } : {}));
  }

  beforeEach(async () => {
    outputs = [];
    inputSeq = 10;
    holdStop = false;
    stopStatus = 200;
    settled = false;
    includeSequence = true;
    pendingStop = undefined;
    saved = null;
    server = createServer(async (request, response) => {
      if (request.method === "POST") {
        let body = "";
        for await (const data of request) body += data;
        const input: unknown = JSON.parse(body);
        const isStop =
          typeof input === "object" && input !== null && "kind" in input && input.kind === "stop";
        const seq = inputSeq++;
        if (isStop && holdStop) {
          pendingStop = { response, seq };
        } else {
          appendResponse(response, seq, isStop ? stopStatus : 200);
        }
        return;
      }
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "X-Stream-Version": "v2",
        "X-Session-Settled": String(settled),
      });
      response.flushHeaders();
      outputs.push(response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    baseURL = `http://127.0.0.1:${address.port}`;
    transport = createTransport({ publicAccessToken: "test-token" });
  });

  afterEach(async () => {
    transport.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function send(abortSignal?: AbortSignal) {
    const before = outputs.length;
    const stream = await transport.sendMessages({
      chatId: "chat",
      trigger: "submit-message",
      messageId: "user",
      messages: [{ id: "user", role: "user", parts: [{ type: "text", text: "Continue" }] }],
      abortSignal,
    });
    await vi.waitFor(() => expect(outputs.length).toBeGreaterThan(before));
    return stream;
  }

  function emit(records: OutputRecord[]) {
    const response = outputs.at(-1);
    if (!response || response.destroyed) throw new Error("The output subscription is closed");
    response.write(`event: batch\ndata: ${JSON.stringify({ records })}\n\n`);
  }

  function oldTailAndReply(oldInput = 11, newInput = 12): OutputRecord[] {
    return [
      chunk(4, { type: "tool-output-available", toolCallId: "old-tool", output: "Late output" }),
      complete(5, oldInput),
      ...reply(6),
      complete(11, newInput),
    ];
  }

  it.each([false, true])(
    "keeps a successor before the Stop acknowledgment (resumed: %s)",
    async (resumed) => {
      const abort = new AbortController();
      let first: ReadableStream<UIMessageChunk>;
      if (resumed) {
        transport.setSession("chat", { publicAccessToken: "test-token", lastEventId: "1" });
        inputSeq = 11;
        const stream = await transport.reconnectToStream({
          chatId: "chat",
          abortSignal: abort.signal,
        });
        if (!stream) throw new Error("Expected a resumed stream");
        first = stream;
        await vi.waitFor(() => expect(outputs).toHaveLength(1));
      } else {
        first = await send(abort.signal);
      }
      const reader = first.getReader();
      emit([
        chunk(2, { type: "start", messageId: "old" }),
        chunk(3, {
          type: "tool-input-available",
          toolCallId: "old-tool",
          toolName: "bash",
          input: {},
        }),
      ]);
      await reader.read();
      await reader.read();
      // Resumed streams do not send Stop on abort. This matches useChat.stop().
      if (resumed) {
        abort.abort();
        await reader.read();
      }
      holdStop = true;
      const stopped = transport.stopGeneration("chat");
      await vi.waitFor(() => expect(pendingStop).toBeDefined());
      const next = await send();
      const pending = pendingStop!;
      appendResponse(pending.response, pending.seq);
      expect(await stopped).toBe(true);
      expect(transport.getSession("chat")?.isStreaming).toBe(true);
      emit(oldTailAndReply());
      await expect(readText(next)).resolves.toBe("New response");
    }
  );

  it.each(["constructor", "setSession"] as const)(
    "retains the stopped boundary through %s hydration",
    async (hydrate) => {
      await send();
      await transport.stopGeneration("chat");
      expect(saved).toMatchObject({
        skipToTurnComplete: true,
        supersededInputSeq: 10,
        isStreaming: false,
      });
      const session = transport.getSession("chat");
      if (!session) throw new Error("Expected persisted state");
      transport.dispose();
      transport = createTransport(
        hydrate === "constructor" ? session : { publicAccessToken: "test-token" }
      );
      if (hydrate === "setSession") transport.setSession("chat", session);
      const next = await send();
      emit(oldTailAndReply());
      await expect(readText(next)).resolves.toBe("New response");
      expect(saved).toMatchObject({ skipToTurnComplete: false, supersededInputSeq: undefined });
    }
  );

  it("retains unread output after a failed Stop request", async () => {
    await send();
    stopStatus = 400;
    expect(await transport.stopGeneration("chat")).toBe(false);
    expect(transport.getSession("chat")?.isStreaming).toBe(false);
    await vi.waitFor(() => expect(outputs[0]?.destroyed).toBe(true));
    const next = await send();
    emit(oldTailAndReply(10, 12));
    await expect(readText(next)).resolves.toBe("New response");
  });

  it("does not resume a stopped owning consumer after hydration", async () => {
    const abort = new AbortController();
    await send(abort.signal);
    abort.abort();
    expect(saved).toMatchObject({
      skipToTurnComplete: true,
      supersededInputSeq: 10,
      isStreaming: false,
    });
    if (!saved) throw new Error("Expected persisted state");
    transport.dispose();
    transport = createTransport(saved);
    expect(await transport.reconnectToStream({ chatId: "chat" })).toBeNull();
  });

  it("closes the SSE connection when the stopped boundary is missing", async () => {
    await send();
    await transport.stopGeneration("chat");
    const next = await send();
    emit([...reply(1), complete(6, 12)]);
    await expect(readText(next)).rejects.toThrow("The previous turn's output was lost");
    await vi.waitFor(() => expect(outputs.at(-1)?.destroyed).toBe(true));
    expect(saved).toMatchObject({
      skipToTurnComplete: false,
      isStreaming: false,
      activeInputSeq: undefined,
    });
  });

  it("does not retain an old stopped input after session recreation", async () => {
    transport.dispose();
    transport = createTransport(
      { publicAccessToken: "test-token" },
      {
        startSession: async () => {
          stopStatus = 200;
          return { publicAccessToken: "replacement-token" };
        },
      }
    );
    await send();
    stopStatus = 404;
    expect(await transport.stopGeneration("chat")).toBe(true);
    expect(saved).toMatchObject({
      skipToTurnComplete: false,
      supersededInputSeq: undefined,
      activeInputSeq: undefined,
    });
    await transport.stopGeneration("chat");
    const next = await send();
    emit([...reply(1), complete(6, 14)]);
    await expect(readText(next)).resolves.toBe("New response");
  });

  it("does not gate a response after a completed turn", async () => {
    const first = await send();
    emit([...reply(1), complete(6, 10)]);
    await expect(readText(first)).resolves.toBe("New response");
    await transport.stopGeneration("chat");
    const next = await send();
    emit([...reply(7), complete(12, 12)]);
    await expect(readText(next)).resolves.toBe("New response");
  });

  it("retains the first stopped boundary after repeated Stop calls", async () => {
    await send();
    await transport.stopGeneration("chat");
    await transport.stopGeneration("chat");
    const next = await send();
    emit(oldTailAndReply(12, 13));
    await expect(readText(next)).resolves.toBe("New response");
  });

  it("does not stop a successor when an old consumer aborts after settled EOF", async () => {
    const abort = new AbortController();
    settled = true;
    const first = await send(abort.signal);
    emit(reply(1));
    outputs[0]!.end();
    await expect(readText(first)).resolves.toBe("New response");
    settled = false;
    const next = await send();
    abort.abort();
    expect(transport.getSession("chat")?.isStreaming).toBe(true);
    emit([...reply(6), complete(11, 11)]);
    await expect(readText(next)).resolves.toBe("New response");
    expect(inputSeq).toBe(12);
  });

  it.each(["message", "action"] as const)(
    "requires transcript reload when a stopped successor %s has no sequence",
    async (kind) => {
      await send();
      await transport.stopGeneration("chat");
      includeSequence = false;
      const reloadError =
        "Stopped chat response cannot be matched. Reload the chat before sending another message.";
      const next = kind === "message" ? send() : transport.sendAction("chat", { type: "undo" });
      await expect(next).rejects.toThrow(reloadError);
      expect(saved).toMatchObject({ requiresTranscriptReload: true, isStreaming: false });
      expect(inputSeq).toBe(13);
      await expect(send()).rejects.toThrow(reloadError);
      await expect(transport.sendAction("chat", { type: "undo" })).rejects.toThrow(reloadError);
      expect(inputSeq).toBe(13);

      if (!saved) throw new Error("Expected persisted state");
      transport.dispose();
      transport = createTransport(saved, { watch: true });
      await expect(send()).rejects.toThrow(reloadError);
      expect(inputSeq).toBe(13);
      expect(await transport.reconnectToStream({ chatId: "chat" })).toBeNull();
      expect(outputs).toHaveLength(1);

      // A fresh transcript supplies a cursor beyond the accepted response.
      transport.dispose();
      transport = createTransport(saved);
      transport.setSession("chat", {
        publicAccessToken: "test-token",
        lastEventId: "11",
        isStreaming: false,
      });
      includeSequence = true;
      const afterReload = await send();
      emit([...reply(12), complete(17, 13)]);
      await expect(readText(afterReload)).resolves.toBe("New response");
    }
  );

  it("accepts a sequence-free response without a stopped boundary", async () => {
    includeSequence = false;
    const stream = await send();
    emit([...reply(1), complete(6, 10)]);
    await expect(readText(stream)).resolves.toBe("New response");
  });

  it("persists a cleared boundary without rearming the abandoned turn after hydration", async () => {
    await send();
    transport.clearSupersedeGate("chat");
    expect(saved).toMatchObject({
      skipToTurnComplete: false,
      supersededInputSeq: undefined,
      activeInputSeq: undefined,
      isStreaming: false,
    });
    if (!saved) throw new Error("Expected persisted state");
    transport.dispose();
    transport = createTransport(saved);
    await transport.stopGeneration("chat");
    const next = await send();
    emit([...reply(1), complete(6, 12)]);
    await expect(readText(next)).resolves.toBe("New response");
  });
});
