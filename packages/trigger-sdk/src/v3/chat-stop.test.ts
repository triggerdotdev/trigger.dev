import { createServer, type Server, type ServerResponse } from "node:http";
import { readUIMessageStream, type UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TriggerChatTransport,
  type ChatSessionPersistedState,
  type ChatTransportEvent,
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

function readWatchedTurn(stream: ReadableStream<UIMessageChunk>): Promise<string> {
  return readText(
    stream.pipeThrough(
      new TransformStream<UIMessageChunk, UIMessageChunk>({
        transform(value, controller) {
          controller.enqueue(value);
          if (value.type === "finish") controller.terminate();
        },
      })
    )
  );
}

describe("Stop with a successor response", () => {
  let server: Server;
  let baseURL: string;
  let transport: TriggerChatTransport;
  let outputs: ServerResponse[];
  let outputHeaders: { peek: boolean; timeout: number }[];
  let inputSeq: number;
  let holdStop: boolean;
  let holdMessages: boolean;
  let stopStatus: number;
  let settled: boolean;
  let resumeAfterStoppedCheckpoint: boolean;
  let emptyRecoveredOutput: boolean;
  let includeSequence: boolean;
  let pendingStop: { response: ServerResponse; seq: number } | undefined;
  let pendingMessages: { response: ServerResponse; seq: number }[];
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
    outputHeaders = [];
    inputSeq = 10;
    holdStop = false;
    holdMessages = false;
    stopStatus = 200;
    settled = false;
    resumeAfterStoppedCheckpoint = false;
    emptyRecoveredOutput = false;
    includeSequence = true;
    pendingStop = undefined;
    pendingMessages = [];
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
        } else if (!isStop && holdMessages) {
          pendingMessages.push({ response, seq });
        } else {
          appendResponse(response, seq, isStop ? stopStatus : 200);
        }
        return;
      }
      const stoppedCheckpointPeek =
        resumeAfterStoppedCheckpoint && request.headers["x-peek-settled"] !== undefined;
      outputHeaders.push({
        peek: request.headers["x-peek-settled"] !== undefined,
        timeout: Number(request.headers["timeout-seconds"]),
      });
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "X-Stream-Version": "v2",
        "X-Session-Settled": String(settled || stoppedCheckpointPeek),
      });
      response.flushHeaders();
      outputs.push(response);
      if (stoppedCheckpointPeek || emptyRecoveredOutput) {
        response.end();
      } else if (resumeAfterStoppedCheckpoint) {
        response.write(
          `event: batch\ndata: ${JSON.stringify({ records: [...reply(12), complete(17, 12)] })}\n\n`
        );
      }
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

  async function hydrateBlockedSession(hydrate: "constructor" | "setSession") {
    const first = await send();
    const reader = first.getReader();
    emit([chunk(1, { type: "start", messageId: "old" })]);
    await reader.read();
    await transport.stopGeneration("chat");
    includeSequence = false;
    await expect(send()).rejects.toThrow("Stopped chat response cannot be matched");
    const session = transport.getSession("chat");
    if (!session) throw new Error("Expected persisted state");
    expect(session).toMatchObject({ requiresTranscriptReload: true, lastEventId: "1" });
    transport.dispose();
    transport = createTransport(
      hydrate === "constructor" ? session : { publicAccessToken: "test-token" }
    );
    if (hydrate === "setSession") transport.setSession("chat", session);
    includeSequence = true;
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

  it.each([false, true])(
    "discards stopped output before the first resumed record (abort first: %s)",
    async (abortFirst) => {
      transport.setSession("chat", { publicAccessToken: "test-token", lastEventId: "1" });
      const abort = new AbortController();
      const resumed = await transport.reconnectToStream({
        chatId: "chat",
        abortSignal: abort.signal,
      });
      if (!resumed) throw new Error("Expected a resumed stream");
      await vi.waitFor(() => expect(outputs).toHaveLength(1));
      const reader = resumed.getReader();
      if (abortFirst) {
        abort.abort();
        expect((await reader.read()).done).toBe(true);
      }
      await transport.stopGeneration("chat");
      const next = await send();
      emit(oldTailAndReply(10, 11));
      await expect(readText(next)).resolves.toBe("New response");
      expect(transport.getSession("chat")?.skipToTurnComplete).toBe(false);
    }
  );

  it.each([
    ["constructor", undefined],
    ["constructor", "1"],
    ["setSession", undefined],
    ["setSession", "1"],
  ] as const)("does not gate idle %s hydration with cursor %s", async (hydrate, lastEventId) => {
    const session = { publicAccessToken: "test-token", lastEventId };
    if (hydrate === "constructor") {
      transport.dispose();
      transport = createTransport(session);
    } else {
      transport.setSession("chat", session);
    }
    expect(await transport.stopGeneration("chat")).toBe(true);
    expect(transport.getSession("chat")?.skipToTurnComplete).not.toBe(true);
    const next = await send();
    emit([...reply(2), complete(7, 11)]);
    await expect(readText(next)).resolves.toBe("New response");
    expect(inputSeq).toBe(12);
  });

  it.each([
    ["message", "idle"],
    ["action", "idle"],
    ["message", "repeated Stop"],
    ["action", "repeated Stop"],
  ] as const)("retains Stop during a pending %s append (%s)", async (kind, state) => {
    holdMessages = true;
    const first = kind === "message" ? send() : transport.sendAction("chat", { type: "undo" });
    await vi.waitFor(() => expect(pendingMessages).toHaveLength(1));
    expect(await transport.stopGeneration("chat")).toBe(true);
    if (state === "repeated Stop") expect(await transport.stopGeneration("chat")).toBe(true);
    expect(transport.getSession("chat")).toMatchObject({
      skipToTurnComplete: true,
      transcriptRecoveryInputSeq: 11,
    });
    expect(transport.getSession("chat")).not.toHaveProperty("pendingInputCount");
    holdMessages = false;
    const pending = pendingMessages[0]!;
    appendResponse(pending.response, pending.seq);
    const firstStream = await first;
    await vi.waitFor(() => expect(outputs).toHaveLength(1));
    const firstResult = readText(firstStream);
    const nextInput = inputSeq;
    const next = await send();
    await expect(firstResult).resolves.toBe("");
    emit(oldTailAndReply(10, nextInput));
    await expect(readText(next)).resolves.toBe("New response");
  });

  it.each(["message", "action"] as const)(
    "retains Stop from the first %s acknowledgment event",
    async (kind) => {
      let stopping: Promise<boolean> | undefined;
      let stopFirst = true;
      transport.setOnEvent((event) => {
        if (event.type === "message-sent" && event.source !== "stop" && stopFirst) {
          stopFirst = false;
          queueMicrotask(() => {
            stopping = transport.stopGeneration("chat");
          });
        }
      });
      const first = await (kind === "message"
        ? send()
        : transport.sendAction("chat", { type: "undo" }));
      await vi.waitFor(() => expect(outputs).toHaveLength(1));
      await expect(stopping).resolves.toBe(true);
      expect(transport.getSession("chat")?.skipToTurnComplete).toBe(true);
      const stopped = readText(first);
      const next = await send();
      await expect(stopped).resolves.toBe("");
      emit(oldTailAndReply(10, 12));
      await expect(readText(next)).resolves.toBe("New response");
    }
  );

  it.each(["message", "action"] as const)(
    "clears pending activity after a failed %s append",
    async (kind) => {
      holdMessages = true;
      const first = kind === "message" ? send() : transport.sendAction("chat", { type: "undo" });
      const failed = expect(first).rejects.toThrow();
      await vi.waitFor(() => expect(pendingMessages).toHaveLength(1));
      const pending = pendingMessages[0]!;
      appendResponse(pending.response, pending.seq, 400);
      await failed;
      holdMessages = false;
      await transport.stopGeneration("chat");
      expect(transport.getSession("chat")?.skipToTurnComplete).not.toBe(true);
      const next = await send();
      emit([...reply(2), complete(7, 12)]);
      await expect(readText(next)).resolves.toBe("New response");
    }
  );

  it.each([
    ["message", "idle"],
    ["action", "idle"],
    ["message", "abandoned"],
    ["action", "abandoned"],
  ] as const)("keeps a rejected %s append idle after Stop (%s)", async (kind, state) => {
    transport.setSession("chat", { publicAccessToken: "test-token", isStreaming: false });
    if (state === "abandoned") transport.clearSupersedeGate("chat");
    holdMessages = true;
    const first = kind === "message" ? send() : transport.sendAction("chat", { type: "undo" });
    const failed = expect(first).rejects.toThrow();
    await vi.waitFor(() => expect(pendingMessages).toHaveLength(1));
    await transport.stopGeneration("chat");
    const pending = pendingMessages[0]!;
    appendResponse(pending.response, pending.seq, 400);
    await failed;
    holdMessages = false;
    expect(transport.getSession("chat")?.skipToTurnComplete).not.toBe(true);
    const next = await send();
    emit([...reply(2), complete(7, 12)]);
    await expect(readText(next)).resolves.toBe("New response");
  });

  it("retains pending activity until every overlapping append finishes", async () => {
    holdMessages = true;
    const first = transport.sendAction("chat", { type: "first" });
    const firstFailure = expect(first).rejects.toThrow();
    const second = transport.sendAction("chat", { type: "second" });
    await vi.waitFor(() => expect(pendingMessages).toHaveLength(2));
    const rejected = pendingMessages[0]!;
    appendResponse(rejected.response, rejected.seq, 400);
    await firstFailure;
    await transport.stopGeneration("chat");
    expect(transport.getSession("chat")?.skipToTurnComplete).toBe(true);
    holdMessages = false;
    const accepted = pendingMessages[1]!;
    appendResponse(accepted.response, accepted.seq);
    const stopped = readText(await second);
    await vi.waitFor(() => expect(outputs).toHaveLength(1));
    const next = await send();
    await expect(stopped).resolves.toBe("");
    emit(oldTailAndReply(11, 13));
    await expect(readText(next)).resolves.toBe("New response");
  });

  it("does not mark an already-canceled reconnect as an outstanding turn", async () => {
    const abort = new AbortController();
    abort.abort();
    const resumed = await transport.reconnectToStream({
      chatId: "chat",
      abortSignal: abort.signal,
    });
    if (!resumed) throw new Error("Expected a resumed stream");
    await expect(readText(resumed)).resolves.toBe("");
    expect(await transport.stopGeneration("chat")).toBe(true);
    const next = await send();
    emit([...reply(2), complete(7, 11)]);
    await expect(readText(next)).resolves.toBe("New response");
  });

  it("does not gate a response after an empty settled resume", async () => {
    settled = true;
    transport.setSession("chat", { publicAccessToken: "test-token", lastEventId: "1" });
    const resumed = await transport.reconnectToStream({ chatId: "chat" });
    if (!resumed) throw new Error("Expected a resumed stream");
    await vi.waitFor(() => expect(outputs).toHaveLength(1));
    outputs[0]!.end();
    await expect(readText(resumed)).resolves.toBe("");
    await transport.stopGeneration("chat");
    settled = false;
    const next = await send();
    emit([...reply(2), complete(7, 11)]);
    await expect(readText(next)).resolves.toBe("New response");
  });

  it("does not transfer an unknown resumed turn to a replacement idle session", async () => {
    const abort = new AbortController();
    const resumed = await transport.reconnectToStream({
      chatId: "chat",
      abortSignal: abort.signal,
    });
    if (!resumed) throw new Error("Expected a resumed stream");
    await vi.waitFor(() => expect(outputs).toHaveLength(1));
    abort.abort();
    await expect(readText(resumed)).resolves.toBe("");
    const session = transport.getSession("chat")!;
    expect(session).not.toHaveProperty("resumedUnknownTurn");
    transport.setSession("chat", session);
    await transport.stopGeneration("chat");
    const next = await send();
    emit([...reply(2), complete(7, 11)]);
    await expect(readText(next)).resolves.toBe("New response");
  });

  it("does not gate a response after Stop on a known idle watch", async () => {
    transport.dispose();
    transport = createTransport(
      { publicAccessToken: "test-token", lastEventId: "1", isStreaming: false },
      { watch: true }
    );
    const resumed = await transport.reconnectToStream({ chatId: "chat" });
    if (!resumed) throw new Error("Expected a watch stream");
    await vi.waitFor(() => expect(outputs).toHaveLength(1));
    await transport.stopGeneration("chat");
    const next = await send();
    emit([...reply(2), complete(7, 11)]);
    await expect(readWatchedTurn(next)).resolves.toBe("New response");
  });

  it("does not gate a response after a passive watch abort with unknown turn state", async () => {
    transport.dispose();
    transport = createTransport(
      { publicAccessToken: "test-token", lastEventId: "1" },
      { watch: true }
    );
    const abort = new AbortController();
    const resumed = await transport.reconnectToStream({
      chatId: "chat",
      abortSignal: abort.signal,
    });
    if (!resumed) throw new Error("Expected a watch stream");
    await vi.waitFor(() => expect(outputs).toHaveLength(1));
    abort.abort();
    await expect(readText(resumed)).resolves.toBe("");
    const next = await send();
    emit([...reply(2), complete(7, 10)]);
    await expect(readWatchedTurn(next)).resolves.toBe("New response");
    expect(inputSeq).toBe(11);
  });

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

  it("rejects a newer snapshot from before the stopped input", async () => {
    await hydrateBlockedSession("constructor");
    const recover = transport.prepareTranscriptRecovery("chat");
    if (!recover) throw new Error("Expected transcript recovery");
    expect(recover({ lastOutEventId: "5", lastInEventId: "9" })).toBe(false);
    await expect(send()).rejects.toThrow("Stopped chat response cannot be matched");
    expect(inputSeq).toBe(13);
  });

  it.each([
    ["explicit", "constructor"],
    ["explicit", "setSession"],
    ["abort", "constructor"],
    ["abort", "setSession"],
  ] as const)(
    "rejects an older snapshot after cursor-free %s Stop and %s hydration",
    async (stopMode, hydrate) => {
      const abort = new AbortController();
      const resumed = await transport.reconnectToStream({
        chatId: "chat",
        abortSignal: abort.signal,
        stopOnAbort: true,
      });
      if (!resumed) throw new Error("Expected a resumed stream");
      await vi.waitFor(() => expect(outputs).toHaveLength(1));
      if (stopMode === "explicit") await transport.stopGeneration("chat");
      else abort.abort();
      await vi.waitFor(() =>
        expect(transport.getSession("chat")?.transcriptRecoveryInputSeq).toBe(10)
      );
      includeSequence = false;
      await expect(send()).rejects.toThrow("Stopped chat response cannot be matched");
      const session = transport.getSession("chat");
      if (!session) throw new Error("Expected persisted state");
      transport.dispose();
      transport = createTransport(
        hydrate === "constructor" ? session : { publicAccessToken: "test-token" }
      );
      if (hydrate === "setSession") transport.setSession("chat", session);
      const stale = transport.prepareTranscriptRecovery("chat");
      if (!stale) throw new Error("Expected transcript recovery");
      expect(stale({ lastOutEventId: "5", lastInEventId: "9" })).toBe(false);
      await expect(send()).rejects.toThrow("Stopped chat response cannot be matched");
      const fresh = transport.prepareTranscriptRecovery("chat");
      if (!fresh) throw new Error("Expected transcript recovery");
      expect(fresh({ lastOutEventId: "11", lastInEventId: "10" })).toBe(true);
      const next = await transport.reconnectToStream({ chatId: "chat" });
      if (!next) throw new Error("Expected a resumed stream");
      await vi.waitFor(() => expect(outputs).toHaveLength(2));
      emit([...reply(12), complete(17, 11)]);
      await expect(readText(next)).resolves.toBe("New response");
      expect(inputSeq).toBe(12);
    }
  );

  it.each([false, true])(
    "retains the first Stop input through repeated Stop (delayed first acknowledgment: %s)",
    async (delayed) => {
      await transport.reconnectToStream({ chatId: "chat" });
      await vi.waitFor(() => expect(outputs).toHaveLength(1));
      holdStop = delayed;
      const firstStop = transport.stopGeneration("chat");
      if (delayed) await vi.waitFor(() => expect(pendingStop).toBeDefined());
      else expect(await firstStop).toBe(true);
      includeSequence = false;
      await expect(send()).rejects.toThrow("Stopped chat response cannot be matched");
      includeSequence = true;
      holdStop = false;
      expect(await transport.stopGeneration("chat")).toBe(true);
      if (delayed) {
        const pending = pendingStop!;
        appendResponse(pending.response, pending.seq);
        expect(await firstStop).toBe(true);
      }
      const recover = transport.prepareTranscriptRecovery("chat");
      if (!recover) throw new Error("Expected transcript recovery");
      expect(recover({ lastOutEventId: "17", lastInEventId: "11" })).toBe(true);
      const next = await send();
      emit([...reply(18), complete(23, 13)]);
      await expect(readText(next)).resolves.toBe("New response");
    }
  );

  it("does not install an old Stop sequence into a replacement session", async () => {
    holdStop = true;
    const stopped = transport.stopGeneration("chat");
    await vi.waitFor(() => expect(pendingStop).toBeDefined());
    transport.setSession("chat", {
      publicAccessToken: "replacement-token",
      skipToTurnComplete: true,
      requiresTranscriptReload: true,
      isStreaming: false,
    });
    const pending = pendingStop!;
    appendResponse(pending.response, pending.seq);
    expect(await stopped).toBe(true);
    const recover = transport.prepareTranscriptRecovery("chat");
    if (!recover) throw new Error("Expected transcript recovery");
    expect(() => recover({ lastOutEventId: "17", lastInEventId: "11" })).toThrow(
      "Transcript recovery requires a stopped input sequence"
    );
    await expect(send()).rejects.toThrow("Stopped chat response cannot be matched");
    holdStop = false;
    expect(await transport.stopGeneration("chat")).toBe(true);
    expect(
      transport.prepareTranscriptRecovery("chat")?.({ lastOutEventId: "17", lastInEventId: "11" })
    ).toBe(true);
  });

  it("accepts a sequence-free response without a stopped boundary", async () => {
    includeSequence = false;
    const stream = await send();
    emit([...reply(1), complete(6, 10)]);
    await expect(readText(stream)).resolves.toBe("New response");
  });

  it("rejects steering before an append when transcript reload is required", async () => {
    await send();
    await transport.stopGeneration("chat");
    includeSequence = false;
    await expect(send()).rejects.toThrow("Stopped chat response cannot be matched");
    const accepted = await transport.sendPendingMessage("chat", {
      id: "steering-message",
      role: "user",
      parts: [{ type: "text", text: "Use the new instructions" }],
    });
    expect({ accepted, inputSeq }).toEqual({ accepted: false, inputSeq: 13 });
  });

  it.each([
    ["constructor", "reconnect"],
    ["constructor", "send"],
    ["setSession", "reconnect"],
    ["setSession", "send"],
  ] as const)(
    "recovers a blocked session through %s hydration and %s after a fresh transcript",
    async (hydrate, operation) => {
      await hydrateBlockedSession(hydrate);
      const recover = transport.prepareTranscriptRecovery("chat");
      if (!recover) throw new Error("Expected transcript recovery");
      expect(recover({ lastOutEventId: "11", lastInEventId: "11" })).toBe(true);
      transport.seedResumeCursor("chat", "11");
      expect(saved).toMatchObject({
        lastEventId: "11",
        requiresTranscriptReload: false,
        skipToTurnComplete: false,
        supersededInputSeq: undefined,
        activeInputSeq: undefined,
      });
      const before = outputs.length;
      const stream =
        operation === "send" ? await send() : await transport.reconnectToStream({ chatId: "chat" });
      if (!stream) throw new Error("Expected a response stream");
      await vi.waitFor(() => expect(outputs.length).toBeGreaterThan(before));
      emit([...reply(12), complete(17, operation === "send" ? 13 : 12)]);
      await expect(readText(stream)).resolves.toBe("New response");
      expect(inputSeq).toBe(operation === "send" ? 14 : 13);
    }
  );

  it.each([undefined, "0", "1"])(
    "retains the reload guard for a missing or stale transcript cursor (%s)",
    async (cursor) => {
      await hydrateBlockedSession("constructor");
      const recover = transport.prepareTranscriptRecovery("chat");
      if (!recover) throw new Error("Expected transcript recovery");
      if (cursor === undefined) {
        expect(() => recover({ lastOutEventId: cursor, lastInEventId: "11" })).toThrow(
          "Transcript recovery requires numeric input and output cursors"
        );
      } else {
        expect(recover({ lastOutEventId: cursor, lastInEventId: "11" })).toBe(false);
      }
      await expect(send()).rejects.toThrow("Stopped chat response cannot be matched");
      await expect(transport.sendAction("chat", { type: "undo" })).rejects.toThrow(
        "Stopped chat response cannot be matched"
      );
      expect(
        await transport.sendPendingMessage("chat", {
          id: "steering-message",
          role: "user",
          parts: [{ type: "text", text: "Use the new instructions" }],
        })
      ).toBe(false);
      expect(await transport.reconnectToStream({ chatId: "chat" })).toBeNull();
      expect(inputSeq).toBe(13);
      expect(transport.getSession("chat")).toMatchObject({
        lastEventId: "1",
        requiresTranscriptReload: true,
      });
    }
  );

  it.each(["none", "constructor", "setSession"] as const)(
    "resumes accepted output after a stopped checkpoint (recovery hydration: %s)",
    async (hydrate) => {
      await hydrateBlockedSession("constructor");
      const recover = transport.prepareTranscriptRecovery("chat");
      if (!recover) throw new Error("Expected transcript recovery");
      expect(recover({ lastOutEventId: "11", lastInEventId: "11" })).toBe(true);
      if (hydrate !== "none") {
        const session = transport.getSession("chat");
        if (!session) throw new Error("Expected persisted state");
        transport.dispose();
        transport = createTransport(
          hydrate === "constructor" ? session : { publicAccessToken: "test-token" }
        );
        if (hydrate === "setSession") transport.setSession("chat", session);
      }
      resumeAfterStoppedCheckpoint = true;
      const resumed = await transport.reconnectToStream({ chatId: "chat" });
      if (!resumed) throw new Error("Expected a resumed stream");
      await expect(readText(resumed)).resolves.toBe("New response");
      expect(inputSeq).toBe(13);
      expect(transport.getSession("chat")).toMatchObject({
        skipSettledPeek: false,
        isStreaming: false,
      });
    }
  );

  it("reports an empty recovery poll and reconnects without another append", async () => {
    await hydrateBlockedSession("constructor");
    const recover = transport.prepareTranscriptRecovery("chat");
    if (!recover) throw new Error("Expected transcript recovery");
    expect(recover({ lastOutEventId: "11", lastInEventId: "11" })).toBe(true);
    const events: ChatTransportEvent[] = [];
    transport.setOnEvent((event) => events.push(event));
    resumeAfterStoppedCheckpoint = true;
    emptyRecoveredOutput = true;
    const resumed = await transport.reconnectToStream({ chatId: "chat" });
    if (!resumed) throw new Error("Expected a resumed stream");
    await expect(readText(resumed)).rejects.toThrow(
      "Chat recovery received no output before the poll ended. Reconnect to resume the accepted message."
    );
    expect(events.filter((event) => event.type === "stream-error")).toHaveLength(1);
    const request = outputHeaders.at(-1);
    if (!request) throw new Error("Expected a stream request");
    expect(request.peek).toBe(false);
    expect(request.timeout).toBeGreaterThan(0);
    expect(request.timeout).toBeLessThanOrEqual(30);
    expect(outputs).toHaveLength(2);
    expect(transport.getSession("chat")).toMatchObject({
      lastEventId: "11",
      isStreaming: undefined,
      skipSettledPeek: true,
    });
    emptyRecoveredOutput = false;
    const next = await transport.reconnectToStream({ chatId: "chat" });
    if (!next) throw new Error("Expected a resumed stream");
    await expect(readText(next)).resolves.toBe("New response");
    expect(inputSeq).toBe(13);
  });

  it("rejects captured recovery after an explicit Stop before its acknowledgment", async () => {
    await hydrateBlockedSession("constructor");
    const recover = transport.prepareTranscriptRecovery("chat");
    if (!recover) throw new Error("Expected transcript recovery");
    holdStop = true;
    const stopped = transport.stopGeneration("chat");
    await vi.waitFor(() => expect(pendingStop).toBeDefined());
    expect(recover({ lastOutEventId: "11", lastInEventId: "11" })).toBe(false);
    await expect(send()).rejects.toThrow("Stopped chat response cannot be matched");
    const pending = pendingStop!;
    appendResponse(pending.response, pending.seq);
    expect(await stopped).toBe(true);
    expect(inputSeq).toBe(14);
    expect(transport.getSession("chat")).toMatchObject({ requiresTranscriptReload: true });
  });

  it("retains the stopped boundary for recovered output before reconnect", async () => {
    await hydrateBlockedSession("constructor");
    expect(
      transport.prepareTranscriptRecovery("chat")?.({ lastOutEventId: "11", lastInEventId: "11" })
    ).toBe(true);
    await transport.stopGeneration("chat");
    expect(transport.getSession("chat")?.skipToTurnComplete).toBe(true);
    const next = await send();
    emit([complete(12, 12), ...reply(13), complete(18, 14)]);
    await expect(readText(next)).resolves.toBe("New response");
    expect(inputSeq).toBe(15);
  });

  it.each(["abort", "stop"] as const)("closes recovery quietly after %s", async (operation) => {
    await hydrateBlockedSession("constructor");
    expect(
      transport.prepareTranscriptRecovery("chat")?.({ lastOutEventId: "11", lastInEventId: "11" })
    ).toBe(true);
    const events: ChatTransportEvent[] = [];
    transport.setOnEvent((event) => events.push(event));
    const abort = new AbortController();
    const resumed = await transport.reconnectToStream({
      chatId: "chat",
      abortSignal: abort.signal,
    });
    if (!resumed) throw new Error("Expected a resumed stream");
    const result = readText(resumed);
    await vi.waitFor(() => expect(outputs).toHaveLength(2));
    if (operation === "abort") abort.abort();
    else await transport.stopGeneration("chat");
    await expect(result).resolves.toBe("");
    expect(events.filter((event) => event.type === "stream-error")).toEqual([]);
    if (operation === "abort") {
      expect(transport.getSession("chat")).toMatchObject({
        isStreaming: undefined,
        skipSettledPeek: true,
      });
      expect(inputSeq).toBe(13);
    } else {
      expect(transport.getSession("chat")).toMatchObject({
        isStreaming: false,
        skipToTurnComplete: true,
      });
      expect(inputSeq).toBe(14);
    }
  });

  it("closes an empty settled recovery without an error", async () => {
    await hydrateBlockedSession("constructor");
    expect(
      transport.prepareTranscriptRecovery("chat")?.({ lastOutEventId: "11", lastInEventId: "11" })
    ).toBe(true);
    const events: ChatTransportEvent[] = [];
    transport.setOnEvent((event) => events.push(event));
    settled = true;
    emptyRecoveredOutput = true;
    const resumed = await transport.reconnectToStream({ chatId: "chat" });
    if (!resumed) throw new Error("Expected a resumed stream");
    await expect(readText(resumed)).resolves.toBe("");
    expect(events.filter((event) => event.type === "stream-error")).toEqual([]);
    expect(transport.getSession("chat")?.isStreaming).toBe(false);
    expect(inputSeq).toBe(13);
  });

  it("reconnects a watch after an empty recovery response", async () => {
    await hydrateBlockedSession("constructor");
    expect(
      transport.prepareTranscriptRecovery("chat")?.({ lastOutEventId: "11", lastInEventId: "11" })
    ).toBe(true);
    const session = transport.getSession("chat")!;
    transport.dispose();
    const events: ChatTransportEvent[] = [];
    transport = createTransport(session, { watch: true, onEvent: (event) => events.push(event) });
    emptyRecoveredOutput = true;
    const resumed = await transport.reconnectToStream({ chatId: "chat" });
    if (!resumed) throw new Error("Expected a resumed stream");
    const result = readWatchedTurn(resumed);
    await vi.waitFor(() => expect(outputs.length).toBeGreaterThanOrEqual(2));
    emptyRecoveredOutput = false;
    resumeAfterStoppedCheckpoint = true;
    await expect(result).resolves.toBe("New response");
    expect(events.filter((event) => event.type === "stream-error")).toEqual([]);
    expect(inputSeq).toBe(13);
  });

  it("uses the active-turn retry policy after recovery receives data", async () => {
    await hydrateBlockedSession("constructor");
    expect(
      transport.prepareTranscriptRecovery("chat")?.({ lastOutEventId: "11", lastInEventId: "11" })
    ).toBe(true);
    const events: ChatTransportEvent[] = [];
    transport.setOnEvent((event) => events.push(event));
    const resumed = await transport.reconnectToStream({ chatId: "chat" });
    if (!resumed) throw new Error("Expected a resumed stream");
    const reader = resumed.getReader();
    await vi.waitFor(() => expect(outputs).toHaveLength(2));
    emit([chunk(12, { type: "start", messageId: "new" })]);
    await expect(reader.read()).resolves.toMatchObject({ value: { type: "start" } });
    outputs.at(-1)!.end();
    await vi.waitFor(() => expect(outputs).toHaveLength(3));
    emit([...reply(12).slice(1), complete(17, 12)]);
    while (!(await reader.read()).done) {}
    expect(events.filter((event) => event.type === "stream-error")).toEqual([]);
    expect(transport.getSession("chat")?.isStreaming).toBe(false);
    expect(inputSeq).toBe(13);
  });

  it("does not let a replaced recovery stream settle the new response", async () => {
    await hydrateBlockedSession("constructor");
    expect(
      transport.prepareTranscriptRecovery("chat")?.({ lastOutEventId: "11", lastInEventId: "11" })
    ).toBe(true);
    const events: ChatTransportEvent[] = [];
    transport.setOnEvent((event) => events.push(event));
    const resumed = await transport.reconnectToStream({ chatId: "chat" });
    if (!resumed) throw new Error("Expected a resumed stream");
    const oldResult = readText(resumed);
    await vi.waitFor(() => expect(outputs).toHaveLength(2));
    const replacement = await send();
    await expect(oldResult).resolves.toBe("");
    expect(transport.getSession("chat")?.isStreaming).toBe(true);
    emit([...reply(12), complete(17, 13)]);
    await expect(readText(replacement)).resolves.toBe("New response");
    expect(events.filter((event) => event.type === "stream-error")).toEqual([]);
    expect(inputSeq).toBe(14);
  });

  it.each(["constructor", "setSession"] as const)(
    "retains the abandoned-turn marker through %s hydration in watch mode",
    async (hydrate) => {
      await send();
      transport.clearSupersedeGate("chat");
      const session = transport.getSession("chat");
      if (!session) throw new Error("Expected persisted state");
      transport.dispose();
      transport = createTransport(
        hydrate === "constructor" ? session : { publicAccessToken: "test-token" },
        { watch: true }
      );
      if (hydrate === "setSession") transport.setSession("chat", session);
      const watched = await transport.reconnectToStream({ chatId: "chat" });
      if (!watched) throw new Error("Expected a watch stream");
      await vi.waitFor(() => expect(outputs).toHaveLength(2));
      const reader = watched.getReader();
      emit([chunk(1, { type: "start", messageId: "abandoned" })]);
      await reader.read();
      await transport.stopGeneration("chat");
      const next = await send();
      emit([...reply(2), complete(7, 12)]);
      await expect(readWatchedTurn(next)).resolves.toBe("New response");
      expect(session).toMatchObject({ outstandingTurnAbandoned: true });
    }
  );

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
