import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readUIMessageStream } from "ai";
import type { UIMessage, UIMessageChunk } from "ai";
import {
  TriggerChatTransport,
  createChatTransport,
  type ChatTransportEvent,
  type ChatSessionPersistedState,
  type TriggerChatTransportOptions,
} from "./chat.js";

// ───────────────────────────────────────────────────────────────────────────
// Test helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Encode chunks as SSE text. The runtime SSE parser
 * ({@link SSEStreamSubscription}) auto-parses the `data:` field via
 * `safeParseJSON` and yields it as `value.chunk`, so each `data:` line
 * just needs to contain the JSON-encoded chunk directly.
 *
 * In production the session backend sends the raw S2 record body as the
 * `data:` field — that body is itself a JSON string (the transport
 * round-trips through `JSON.stringify`/`JSON.parse`). The transport's
 * SSE reader handles both shapes (`typeof value.chunk === "string"` →
 * parse-once, `=== "object"` → use as-is). We pick the object form
 * here for test simplicity.
 */
/**
 * Encode test chunks as a session-stream v2 SSE batch event. Each chunk
 * becomes one S2 record; chunks of shape `{type: "trigger:turn-complete"}`
 * or `{type: "trigger:upgrade-required"}` are translated into header-form
 * control records (empty body, `trigger-control` header) to match the
 * production wire shape.
 */
function sseEncode(chunks: (UIMessageChunk | Record<string, unknown>)[]): string {
  let nextSeq = 1;
  const records = chunks.map((chunk, i) => {
    const partId = `p-${i}`;
    const type = (chunk as { type?: unknown }).type;
    if (type === "trigger:turn-complete") {
      const headers: Array<[string, string]> = [["trigger-control", "turn-complete"]];
      const token = (chunk as { publicAccessToken?: string }).publicAccessToken;
      if (token) headers.push(["public-access-token", token]);
      const cursor = (chunk as { sessionInEventId?: number }).sessionInEventId;
      if (cursor !== undefined) headers.push(["session-in-event-id", String(cursor)]);
      return {
        body: "",
        seq_num: nextSeq++,
        timestamp: 1700000000000 + i,
        headers,
      };
    }
    if (type === "trigger:turn-start") {
      const inSeq = (chunk as { inSeq?: number }).inSeq;
      return {
        body: "",
        seq_num: nextSeq++,
        timestamp: 1700000000000 + i,
        headers: [
          ["trigger-control", "turn-start"],
          ...(inSeq !== undefined ? [["turn-start-in-seq", String(inSeq)]] : []),
        ],
      };
    }
    if (type === "trigger:turn-join") {
      return {
        body: "",
        seq_num: nextSeq++,
        timestamp: 1700000000000 + i,
        headers: [
          ["trigger-control", "turn-join"],
          ["turn-start-in-seq", String((chunk as { inSeq?: number }).inSeq)],
        ],
      };
    }
    if (type === "trigger:upgrade-required") {
      return {
        body: "",
        seq_num: nextSeq++,
        timestamp: 1700000000000 + i,
        headers: [["trigger-control", "upgrade-required"]],
      };
    }
    if (type === "trigger:pending-version") {
      return {
        body: "",
        seq_num: nextSeq++,
        timestamp: 1700000000000 + i,
        headers: [["trigger-control", "pending-version"]],
      };
    }
    return {
      body: JSON.stringify({ data: chunk, id: partId }),
      seq_num: nextSeq++,
      timestamp: 1700000000000 + i,
      headers: [],
    };
  });
  return `event: batch\ndata: ${JSON.stringify({ records })}\n\n`;
}

function createSSEStream(sseText: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseText));
      controller.close();
    },
  });
}

let messageIdCounter = 0;
function createUserMessage(text: string): UIMessage {
  return {
    id: `msg-user-${++messageIdCounter}`,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

const sampleChunks: UIMessageChunk[] = [
  { type: "text-start", id: "part-1" },
  { type: "text-delta", id: "part-1", delta: "Hello" },
  { type: "text-delta", id: "part-1", delta: " world" },
  { type: "text-delta", id: "part-1", delta: "!" },
  { type: "text-end", id: "part-1" },
];

const sampleChunksWithTurnComplete: (UIMessageChunk | Record<string, unknown>)[] = [
  ...sampleChunks,
  { type: "trigger:turn-complete" },
];

// URL predicates
function isSessionCreateUrl(urlStr: string): boolean {
  return urlStr.endsWith("/api/v1/sessions") || urlStr.endsWith("/api/v1/sessions/");
}
function isSessionOutSubscribeUrl(urlStr: string): boolean {
  return /\/realtime\/v1\/sessions\/[^/]+\/out$/.test(urlStr);
}
function isSessionStreamAppendUrl(urlStr: string): boolean {
  return /\/realtime\/v1\/sessions\/[^/]+\/(in|out)\/append$/.test(urlStr);
}
function chatIdFromUrl(urlStr: string): string | undefined {
  const m = urlStr.match(/\/realtime\/v1\/sessions\/([^/]+)\//);
  return m?.[1];
}

const _DEFAULT_RUN_ID = "run_default";
const _DEFAULT_SESSION_ID = "session_default";
const _DEFAULT_SESSION_PAT = "pat_session_default";
function defaultAppendResponse(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function defaultSseResponse(
  chunks: (UIMessageChunk | Record<string, unknown>)[] = sampleChunksWithTurnComplete
): Response {
  return new Response(createSSEStream(sseEncode(chunks)), {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      // Session streams are always v2 in production — batch format
      // with one S2 record per SSE event. The legacy v1 path is for
      // run-scoped Redis streams.
      "X-Stream-Version": "v2",
    },
  });
}

/**
 * An SSE response whose body stays open until the request signal aborts.
 * Models a live subscription sitting on a quiet server.
 */
function openSseResponse(signal?: AbortSignal | null): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        try {
          controller.error(err);
        } catch {
          /* already errored */
        }
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "X-Stream-Version": "v2",
    },
  });
}

function authError(status = 401): Response {
  return new Response(JSON.stringify({ error: "Unauthorized", name: "TriggerApiError", status }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Drains a UIMessageChunk stream into an array. Used to assert what
 * the transport surfaced after filtering control chunks.
 */
async function drainChunks(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const out: UIMessageChunk[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

describe("TriggerChatTransport", () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("creates with required options", () => {
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
      });
      expect(transport).toBeInstanceOf(TriggerChatTransport);
    });

    it("createChatTransport returns a TriggerChatTransport", () => {
      const transport = createChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
      });
      expect(transport).toBeInstanceOf(TriggerChatTransport);
    });

    it("hydrates sessions from options.sessions", () => {
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: {
          "chat-1": {
            publicAccessToken: "hydrated-pat",
            lastEventId: "42",
            activeInputSeq: 41,
            isStreaming: false,
          },
        },
      });

      const session = transport.getSession("chat-1");
      expect(session).toEqual({
        publicAccessToken: "hydrated-pat",
        lastEventId: "42",
        activeInputSeq: 41,
        isStreaming: false,
      });
    });

    it("returns undefined for unknown chatIds", () => {
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
      });
      expect(transport.getSession("unknown")).toBeUndefined();
    });
  });

  describe("setSession / setOnSessionChange", () => {
    it("setSession installs persisted state and notifies", () => {
      const onSessionChange = vi.fn();
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        onSessionChange,
      });

      transport.setSession("chat-x", {
        publicAccessToken: "tok",
        lastEventId: "10",
        activeInputSeq: 9,
      });

      expect(transport.getSession("chat-x")).toMatchObject({
        publicAccessToken: "tok",
        lastEventId: "10",
        activeInputSeq: 9,
      });
      expect(onSessionChange).toHaveBeenCalledWith(
        "chat-x",
        expect.objectContaining({
          publicAccessToken: "tok",
          lastEventId: "10",
          activeInputSeq: 9,
        })
      );
    });

    it("setOnSessionChange swaps the callback at runtime", () => {
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
      });

      const cb1 = vi.fn();
      const cb2 = vi.fn();
      transport.setOnSessionChange(cb1);
      transport.setSession("c", { publicAccessToken: "t1" });
      expect(cb1).toHaveBeenCalledTimes(1);

      transport.setOnSessionChange(cb2);
      transport.setSession("c", { publicAccessToken: "t2" });
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  describe("setAccessToken / setStartSession / setFetch", () => {
    it("swaps startSession and accessToken at runtime", async () => {
      const startSession1 = vi.fn().mockResolvedValue({ publicAccessToken: "pat-1" });
      const startSession2 = vi.fn().mockResolvedValue({ publicAccessToken: "pat-2" });
      const accessToken2 = vi.fn().mockReturnValue("pat-3");

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "old-pat",
        startSession: startSession1,
      });

      transport.setStartSession(startSession2);
      const started = await transport.start("chat-1");
      expect(startSession1).not.toHaveBeenCalled();
      expect(started.publicAccessToken).toBe("pat-2");

      // No startSession: the session PAT comes from `accessToken` instead.
      transport.setStartSession(undefined);
      transport.setAccessToken(accessToken2);
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });
      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-2",
        messageId: undefined,
        messages: [createUserMessage("Hi")],
        abortSignal: undefined,
      });
      await drainChunks(stream);
      expect(accessToken2).toHaveBeenCalledWith({ chatId: "chat-2" });
    });

    it("ignores the turn-start and turn-join markers the agent writes", async () => {
      // Catches: a transport that renders, errors on or stalls at the
      // `turn-start` control record a newer agent writes, instead of skipping it
      // as it does any control record it doesn't know.
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) {
          return defaultSseResponse([
            { type: "trigger:turn-start", inSeq: 4 },
            { type: "text-start", id: "part-1" },
            { type: "text-delta", id: "part-1", delta: "hello" },
            { type: "trigger:turn-join", inSeq: 5 },
            { type: "text-end", id: "part-1" },
            { type: "trigger:turn-complete" },
          ]);
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: { "chat-marker": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-marker",
        messageId: undefined,
        messages: [createUserMessage("hi")],
        abortSignal: undefined,
      });

      expect((await drainChunks(stream)).map((c) => c.type)).toEqual([
        "text-start",
        "text-delta",
        "text-end",
      ]);
    });

    it("serves a stream reconnect through the fetch set after the first connect", async () => {
      const subscribes: string[] = [];
      const respond = async (urlStr: string, servedBy: string) => {
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) {
          subscribes.push(servedBy);
          // First window ends mid-turn, so the transport resubscribes.
          return subscribes.length === 1
            ? defaultSseResponse([{ type: "text-start", id: "part-1" }])
            : defaultSseResponse([
                { type: "text-delta", id: "part-1", delta: "resumed" },
                { type: "trigger:turn-complete" },
              ]);
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      };

      let transport: TriggerChatTransport;
      const fetch2 = vi.fn(async (url: string) => respond(url, "fetch2"));
      const fetch1 = vi.fn(async (url: string) => {
        const response = await respond(url, "fetch1");
        // The host swaps the override while the first stream window is open.
        if (isSessionOutSubscribeUrl(url)) transport.setFetch(fetch2);
        return response;
      });

      transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: { "chat-reconnect": { publicAccessToken: "p" } },
        fetch: fetch1,
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-reconnect",
        messageId: undefined,
        messages: [createUserMessage("hi")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      expect(subscribes).toEqual(["fetch1", "fetch2"]);
    });

    it("swaps the fetch override at runtime", async () => {
      const respond = async (urlStr: string) => {
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      };
      const fetch1 = vi.fn(async (url: string) => respond(url));
      const fetch2 = vi.fn(async (url: string) => respond(url));

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        baseURL: "https://api.test.trigger.dev",
        sessions: { "chat-1": { publicAccessToken: "p" } },
        fetch: fetch1,
      });

      transport.setFetch(fetch2);
      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-1",
        messageId: "m1",
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      expect(fetch1).not.toHaveBeenCalled();
      expect(fetch2).toHaveBeenCalled();
    });
  });

  describe("start", () => {
    it("calls the customer's startSession callback and caches the returned PAT", async () => {
      const startSession = vi.fn().mockResolvedValue({ publicAccessToken: "session-pat-1" });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "should-not-be-called",
        startSession,
      });

      const result = await transport.start("chat-1");

      expect(startSession).toHaveBeenCalledWith({
        taskId: "my-chat-task",
        chatId: "chat-1",
        clientData: {},
      });
      expect(result.publicAccessToken).toBe("session-pat-1");
      expect(transport.getSession("chat-1")?.publicAccessToken).toBe("session-pat-1");
    });

    it("is idempotent — second call returns the cached state without re-invoking startSession", async () => {
      const startSession = vi.fn().mockResolvedValue({ publicAccessToken: "session-pat-2" });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        startSession,
      });

      await transport.start("chat-2");
      await transport.start("chat-2");
      expect(startSession).toHaveBeenCalledTimes(1);
    });

    it("dedupes concurrent calls via an in-flight promise", async () => {
      let resolveStart!: (r: { publicAccessToken: string }) => void;
      const startPromise = new Promise<{ publicAccessToken: string }>((resolve) => {
        resolveStart = resolve;
      });
      const startSession = vi.fn().mockReturnValue(startPromise);

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        startSession,
      });

      const a = transport.start("chat-3");
      const b = transport.start("chat-3");

      resolveStart({ publicAccessToken: "session-pat-3" });
      await Promise.all([a, b]);

      expect(startSession).toHaveBeenCalledTimes(1);
    });

    it("preload() is an alias for start()", async () => {
      const startSession = vi.fn().mockResolvedValue({ publicAccessToken: "session-pat-pre" });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        startSession,
      });

      await transport.preload("chat-pre");
      expect(startSession).toHaveBeenCalledTimes(1);
      expect(transport.getSession("chat-pre")?.publicAccessToken).toBe("session-pat-pre");
    });

    it("throws a clear error when start() is called without startSession configured", async () => {
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
      });
      await expect(transport.start("chat-no-start")).rejects.toThrow(/startSession/);
    });

    it("threads the transport's `clientData` through to startSession", async () => {
      const startSession = vi.fn().mockResolvedValue({ publicAccessToken: "session-pat-cd" });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        startSession,
        clientData: { userId: "u-1", model: "claude-sonnet-4-6" },
      });

      await transport.start("chat-cd");

      expect(startSession).toHaveBeenCalledWith({
        taskId: "my-chat-task",
        chatId: "chat-cd",
        clientData: { userId: "u-1", model: "claude-sonnet-4-6" },
      });
    });

    it("setClientData updates the value passed to subsequent startSession calls", async () => {
      const startSession = vi.fn().mockResolvedValue({ publicAccessToken: "session-pat-set" });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        startSession,
        clientData: { userId: "old" },
      });

      transport.setClientData({ userId: "new" });
      await transport.start("chat-set");

      expect(startSession).toHaveBeenCalledWith({
        taskId: "my-chat-task",
        chatId: "chat-set",
        clientData: { userId: "new" },
      });
    });
  });

  describe("ensureSessionState (lazy start on first sendMessage)", () => {
    it("calls startSession lazily on first sendMessage when no PAT is hydrated", async () => {
      const startSession = vi.fn().mockResolvedValue({ publicAccessToken: "lazy-session-pat" });

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "should-not-be-called",
        startSession,
        baseURL: "https://api.test.trigger.dev",
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-lazy",
        messageId: undefined,
        messages: [createUserMessage("hi")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      expect(startSession).toHaveBeenCalledTimes(1);
      expect(startSession).toHaveBeenCalledWith({
        taskId: "my-chat-task",
        chatId: "chat-lazy",
        clientData: {},
      });
      expect(transport.getSession("chat-lazy")?.publicAccessToken).toBe("lazy-session-pat");
    });

    it("falls back to accessToken when no startSession is configured (out-of-band session create)", async () => {
      const accessToken = vi.fn().mockResolvedValue("server-mediated-pat");

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken,
        baseURL: "https://api.test.trigger.dev",
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-server",
        messageId: undefined,
        messages: [createUserMessage("hi")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      expect(accessToken).toHaveBeenCalledTimes(1);
      expect(accessToken).toHaveBeenCalledWith({ chatId: "chat-server" });
    });

    it("does not call accessToken when a PAT is hydrated", async () => {
      const accessToken = vi.fn().mockResolvedValue("should-not-be-called");

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken,
        sessions: {
          "chat-h": { publicAccessToken: "hydrated-pat" },
        },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-h",
        messageId: undefined,
        messages: [createUserMessage("hi")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      expect(accessToken).not.toHaveBeenCalled();
    });
  });

  describe("run-pending-version", () => {
    it("emits on send when the append response says the run is parked", async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          return new Response(JSON.stringify({ ok: true, seq: 1, pendingVersion: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const events: ChatTransportEvent[] = [];
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        onEvent: (e) => events.push(e),
        sessions: { "chat-parked": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-parked",
        messageId: "m1",
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "run-pending-version",
            chatId: "chat-parked",
            source: "send",
          }),
        ])
      );
    });

    it("stays quiet on an ordinary append response", async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const events: ChatTransportEvent[] = [];
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        onEvent: (e) => events.push(e),
        sessions: { "chat-normal": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-normal",
        messageId: "m1",
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      expect(events.some((e) => e.type === "run-pending-version")).toBe(false);
    });

    it("emits on start when startSession reports a parked run", async () => {
      const events: ChatTransportEvent[] = [];
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "should-not-be-called",
        onEvent: (e) => events.push(e),
        startSession: vi.fn().mockResolvedValue({ publicAccessToken: "pat", pendingVersion: true }),
      });

      await transport.start("chat-start-parked");

      expect(events).toEqual([
        expect.objectContaining({
          type: "run-pending-version",
          chatId: "chat-start-parked",
          source: "start",
        }),
      ]);
    });

    it("stays quiet when startSession reports nothing", async () => {
      const events: ChatTransportEvent[] = [];
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "should-not-be-called",
        onEvent: (e) => events.push(e),
        startSession: vi.fn().mockResolvedValue({ publicAccessToken: "pat" }),
      });

      await transport.start("chat-start-normal");

      expect(events.some((e) => e.type === "run-pending-version")).toBe(false);
    });
  });

  describe("sendMessages", () => {
    it("posts the user message to .in/append and streams chunks from .out", async () => {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        requests.push({ url: urlStr, init });
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        baseURL: "https://api.test.trigger.dev",
        sessions: { "chat-1": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-1",
        messageId: "m1",
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });
      const chunks = await drainChunks(stream);

      // Five UI chunks pass through; trigger:turn-complete is filtered.
      expect(chunks).toHaveLength(sampleChunks.length);
      expect(chunks[0]).toEqual(sampleChunks[0]);

      const append = requests.find(
        (r) => isSessionStreamAppendUrl(r.url) && r.url.endsWith("/in/append")
      );
      expect(append).toBeDefined();
      expect(chatIdFromUrl(append!.url)).toBe("chat-1");

      // Body is the serialized ChatInputChunk.
      const body = JSON.parse(append!.init!.body as string);
      expect(body.kind).toBe("message");
      expect(body.payload.chatId).toBe("chat-1");
      expect(body.payload.trigger).toBe("submit-message");
    });

    it("addresses .out SSE by chatId (not by sessionId)", async () => {
      const requests: string[] = [];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        requests.push(urlStr);
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        baseURL: "https://api.test.trigger.dev",
        sessions: { "chat-by-chatid": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-by-chatid",
        messageId: undefined,
        messages: [createUserMessage("Hi")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      const subscribe = requests.find(isSessionOutSubscribeUrl);
      expect(subscribe).toBeDefined();
      expect(subscribe!).toContain("/realtime/v1/sessions/chat-by-chatid/out");
    });

    it("functional baseURL dispatches per endpoint (in vs out)", async () => {
      const requests: Array<{ url: string; ctxEndpoint: string | undefined }> = [];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        requests.push({ url: urlStr, ctxEndpoint: undefined });
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const baseURLFn = vi.fn(({ endpoint }: { endpoint: "in" | "out"; chatId: string }) =>
        endpoint === "out" ? "https://stream.example.com" : "https://api.example.com"
      );

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        baseURL: baseURLFn,
        sessions: { "chat-fn": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-fn",
        messageId: undefined,
        messages: [createUserMessage("Hi")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      const appendCalls = baseURLFn.mock.calls.filter((c) => c[0].endpoint === "in");
      const outCalls = baseURLFn.mock.calls.filter((c) => c[0].endpoint === "out");
      expect(appendCalls.length).toBeGreaterThanOrEqual(1);
      expect(outCalls.length).toBeGreaterThanOrEqual(1);
      expect(appendCalls[0]![0].chatId).toBe("chat-fn");
      expect(outCalls[0]![0].chatId).toBe("chat-fn");

      const append = requests.find((r) => isSessionStreamAppendUrl(r.url));
      const subscribe = requests.find((r) => isSessionOutSubscribeUrl(r.url));
      expect(append!.url.startsWith("https://api.example.com/")).toBe(true);
      expect(subscribe!.url.startsWith("https://stream.example.com/")).toBe(true);
    });

    it("fetch override is invoked for both .in/append and .out SSE with endpoint ctx", async () => {
      const fetchCalls: Array<{ url: string; endpoint: string; chatId: string }> = [];

      const customFetch = vi.fn(
        async (url: string, init: RequestInit, ctx: { endpoint: "in" | "out"; chatId: string }) => {
          fetchCalls.push({ url, endpoint: ctx.endpoint, chatId: ctx.chatId });
          if (isSessionStreamAppendUrl(url)) return defaultAppendResponse();
          if (isSessionOutSubscribeUrl(url)) return defaultSseResponse();
          throw new Error(`Unexpected URL: ${url}`);
        }
      );

      global.fetch = vi.fn().mockRejectedValue(new Error("global fetch should not be called"));

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        baseURL: "https://api.test.trigger.dev",
        fetch: customFetch,
        sessions: { "chat-fetch": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-fetch",
        messageId: undefined,
        messages: [createUserMessage("Hi")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      const inCalls = fetchCalls.filter((c) => c.endpoint === "in");
      const outCalls = fetchCalls.filter((c) => c.endpoint === "out");
      expect(inCalls.length).toBeGreaterThanOrEqual(1);
      expect(outCalls.length).toBeGreaterThanOrEqual(1);
      expect(inCalls[0]!.chatId).toBe("chat-fetch");
      expect(outCalls[0]!.chatId).toBe("chat-fetch");
    });

    it("routes .out SSE through streamBaseURL while appends stay on baseURL", async () => {
      const requests: string[] = [];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        requests.push(urlStr);
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        baseURL: "https://api.test.trigger.dev",
        streamBaseURL: "https://chat-proxy.example.com",
        sessions: { "chat-split": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-split",
        messageId: undefined,
        messages: [createUserMessage("Hi")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      const append = requests.find(isSessionStreamAppendUrl);
      const subscribe = requests.find(isSessionOutSubscribeUrl);
      expect(append!.startsWith("https://api.test.trigger.dev/")).toBe(true);
      expect(subscribe!.startsWith("https://chat-proxy.example.com/")).toBe(true);
      expect(subscribe!).toContain("/realtime/v1/sessions/chat-split/out");
    });

    it("for submit-message, only the latest message is delivered to .in", async () => {
      // Slim wire: each `.in/append` carries at most ONE new message in
      // `payload.message` (singular). Even if the caller hands sendMessages
      // an array of three, only the last element flows to the wire — the
      // agent rebuilds prior history at run boot from snapshot + replay.
      let appendBody: any;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          appendBody = JSON.parse(init!.body as string);
          return defaultAppendResponse();
        }
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: { "chat-slice": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-slice",
        messageId: undefined,
        messages: [
          createUserMessage("first"),
          createUserMessage("second"),
          createUserMessage("third"),
        ],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      expect(appendBody.payload.message).toBeDefined();
      expect(appendBody.payload.message.parts[0].text).toBe("third");
      expect(appendBody.payload.messages).toBeUndefined();
    });

    it("for regenerate-message, no message is delivered to .in (server slices its own tail)", async () => {
      // Slim wire: the regenerate trigger ships NO message — the agent
      // trims the trailing assistant from its accumulator and re-runs from
      // the prior user turn. The wire payload only carries the trigger
      // discriminator + chatId + metadata.
      let appendBody: any;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          appendBody = JSON.parse(init!.body as string);
          return defaultAppendResponse();
        }
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: { "chat-regen": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "regenerate-message",
        chatId: "chat-regen",
        messageId: undefined,
        messages: [createUserMessage("a"), createUserMessage("b")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      expect(appendBody.payload.trigger).toBe("regenerate-message");
      expect(appendBody.payload.message).toBeUndefined();
      expect(appendBody.payload.messages).toBeUndefined();
    });

    it("merges transport-level clientData into per-call metadata (per-call wins)", async () => {
      let appendBody: any;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          appendBody = JSON.parse(init!.body as string);
          return defaultAppendResponse();
        }
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        clientData: { userId: "u1", scope: "default" } as Record<string, unknown>,
        sessions: { "chat-md": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-md",
        messageId: undefined,
        messages: [createUserMessage("hi")],
        abortSignal: undefined,
        metadata: { scope: "request" } as never,
      });
      await drainChunks(stream);

      expect(appendBody.payload.metadata).toEqual({ userId: "u1", scope: "request" });
    });

    it("filters trigger:upgrade-required and continues reading", async () => {
      const chunks: (UIMessageChunk | Record<string, unknown>)[] = [
        ...sampleChunks.slice(0, 2),
        { type: "trigger:upgrade-required" },
        ...sampleChunks.slice(2),
        { type: "trigger:turn-complete" },
      ];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse(chunks);
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: { "chat-up": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-up",
        messageId: undefined,
        messages: [createUserMessage("hi")],
        abortSignal: undefined,
      });
      const surfaced = await drainChunks(stream);

      // Both control chunks are filtered.
      expect(surfaced).toHaveLength(sampleChunks.length);
      expect(surfaced.find((c: any) => c.type === "trigger:upgrade-required")).toBeUndefined();
      expect(surfaced.find((c: any) => c.type === "trigger:turn-complete")).toBeUndefined();
    });

    it("emits run-pending-version from an upgrade handing over to an unlanded deployment", async () => {
      const chunks: (UIMessageChunk | Record<string, unknown>)[] = [
        ...sampleChunks.slice(0, 2),
        { type: "trigger:pending-version" },
        { type: "trigger:upgrade-required" },
        ...sampleChunks.slice(2),
        { type: "trigger:turn-complete" },
      ];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse(chunks);
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const events: ChatTransportEvent[] = [];
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        onEvent: (e) => events.push(e),
        sessions: { "chat-parked-upgrade": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-parked-upgrade",
        messageId: undefined,
        messages: [createUserMessage("hi")],
        abortSignal: undefined,
      });
      const surfaced = await drainChunks(stream);

      const parked = events.filter((e) => e.type === "run-pending-version");
      expect(parked).toHaveLength(1);
      expect(parked[0]).toMatchObject({ source: "upgrade", chatId: "chat-parked-upgrade" });
      expect(surfaced).toHaveLength(sampleChunks.length);
      expect(surfaced.find((c: any) => c.type === "trigger:pending-version")).toBeUndefined();
    });

    it("clears isStreaming on turn-complete and notifies", async () => {
      const onSessionChange = vi.fn();
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        onSessionChange,
        sessions: { "chat-tc": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-tc",
        messageId: undefined,
        messages: [createUserMessage("hi")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      const lastIsStreamingFalse = onSessionChange.mock.calls
        .map((call) => call[1])
        .reverse()
        .find((s) => s !== null && s.isStreaming === false);
      expect(lastIsStreamingFalse).toBeDefined();
    });
  });

  describe("auth retry on 401", () => {
    it("refreshes the PAT via accessToken and retries the .in/append once", async () => {
      const accessToken = vi.fn().mockResolvedValue("fresh-pat");
      let appendCount = 0;
      let appendAuth: string | null = null;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          appendCount++;
          if (appendCount === 1) return authError(401);
          appendAuth = new Headers(init?.headers).get("Authorization");
          return defaultAppendResponse();
        }
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken,
        sessions: { "chat-401": { publicAccessToken: "stale-pat" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-401",
        messageId: undefined,
        messages: [createUserMessage("hi")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      expect(accessToken).toHaveBeenCalledWith({ chatId: "chat-401" });
      expect(appendCount).toBe(2);
      expect(appendAuth).toBe("Bearer fresh-pat");
      expect(transport.getSession("chat-401")?.publicAccessToken).toBe("fresh-pat");
    });

    function midTurnHarness() {
      const encoder = new TextEncoder();
      const record = (seq: number, chunk: UIMessageChunk | undefined) =>
        chunk
          ? {
              body: JSON.stringify({ data: chunk, id: `p-${seq}` }),
              seq_num: seq,
              timestamp: seq,
              headers: [],
            }
          : {
              body: "",
              seq_num: seq,
              timestamp: seq,
              headers: [["trigger-control", "turn-complete"]],
            };
      const batch = (records: unknown[]) =>
        encoder.encode(`event: batch\ndata: ${JSON.stringify({ records })}\n\n`);

      let outController: ReadableStreamDefaultController<Uint8Array> | undefined;
      const appends: number[] = [];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          appends.push(appends.length + 1);
          return appends.length === harness.failAppend ? authError(401) : defaultAppendResponse();
        }
        if (isSessionOutSubscribeUrl(urlStr)) {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              outController = controller;
              controller.enqueue(
                batch([
                  record(41, { type: "start", messageId: "a-1" }),
                  record(42, { type: "text-start", id: "t-1" }),
                  record(43, { type: "text-delta", id: "t-1", delta: "Reading" }),
                ])
              );
            },
          });
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream", "X-Stream-Version": "v2" },
          });
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const harness = {
        failAppend: 0,
        appends,
        persisted: [] as ChatSessionPersistedState[],
        completeTurn() {
          outController!.enqueue(
            batch([record(44, { type: "text-end", id: "t-1" }), record(45, undefined)])
          );
          outController!.close();
        },
      };
      return harness;
    }

    it("persists the turn's starting cursor when a refresh lands mid-turn", async () => {
      const harness = midTurnHarness();
      harness.failAppend = 2;
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: vi.fn().mockResolvedValue("fresh-pat"),
        sessions: { "chat-mid": { publicAccessToken: "stale-pat", lastEventId: "40" } },
        onSessionChange: (_chatId, session) => {
          if (session) harness.persisted.push(session);
        },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-mid",
        messageId: undefined,
        messages: [createUserMessage("research queues")],
        abortSignal: undefined,
      });
      const reader = stream.getReader();
      for (let i = 0; i < 3; i++) await reader.read();

      await transport.sendPendingMessage("chat-mid", createUserMessage("cover cost too"));

      expect(harness.appends).toHaveLength(3);
      const refreshed = harness.persisted.at(-1)!;
      expect(refreshed.publicAccessToken).toBe("fresh-pat");
      expect(refreshed.isStreaming).toBe(true);
      expect(refreshed.lastEventId).toBe("40");
      expect(transport.getSession("chat-mid")?.lastEventId).toBe("40");

      harness.completeTurn();
      while (!(await reader.read()).done) {}

      const completed = harness.persisted.at(-1)!;
      expect(completed.isStreaming).toBe(false);
      expect(completed.lastEventId).toBe("45");
    });

    it("keeps the turn's starting cursor after a reconnect when the session was saved without isStreaming", async () => {
      const harness = midTurnHarness();
      harness.failAppend = 1;
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: vi.fn().mockResolvedValue("fresh-pat"),
        sessions: { "chat-reload": { publicAccessToken: "stale-pat", lastEventId: "40" } },
        onSessionChange: (_chatId, session) => {
          if (session) harness.persisted.push(session);
        },
      });

      const stream = await transport.reconnectToStream({ chatId: "chat-reload" });
      const reader = stream!.getReader();
      for (let i = 0; i < 3; i++) await reader.read();

      await transport.sendPendingMessage("chat-reload", createUserMessage("cover cost too"));

      expect(harness.appends).toHaveLength(2);
      const refreshed = harness.persisted.at(-1)!;
      expect(refreshed.publicAccessToken).toBe("fresh-pat");
      expect(refreshed.lastEventId).toBe("40");
      expect(transport.getSession("chat-reload")?.lastEventId).toBe("40");

      harness.completeTurn();
      while (!(await reader.read()).done) {}

      expect(transport.getSession("chat-reload")?.lastEventId).toBe("45");
    });
  });

  describe("stopGeneration", () => {
    it("posts {kind: stop} to .in/append and returns true", async () => {
      let stopBody: any;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          stopBody = JSON.parse(init!.body as string);
          return defaultAppendResponse();
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: { "chat-stop": { publicAccessToken: "p" } },
      });

      const ok = await transport.stopGeneration("chat-stop");
      expect(ok).toBe(true);
      expect(stopBody).toEqual({ kind: "stop" });
    });

    it("returns false when there is no session for the chatId", async () => {
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
      });
      const ok = await transport.stopGeneration("never-started");
      expect(ok).toBe(false);
    });
  });

  describe("retry after stop (stopped turn stays gated)", () => {
    function settled(response: Response): Response {
      const headers = new Headers(response.headers);
      headers.set("X-Session-Settled", "true");
      return new Response(response.body, { status: 200, headers });
    }

    function gateTransport(
      sessions: Record<string, ChatSessionPersistedState>,
      overrides: Partial<TriggerChatTransportOptions> = {}
    ) {
      return new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions,
        ...overrides,
      });
    }

    // Builds a transport with a single hydrated session and stops it, since
    // every "retry after stop" case starts from an already-stopped turn.
    async function armedGate(
      chatId: string,
      state: ChatSessionPersistedState,
      overrides: Partial<TriggerChatTransportOptions> = {}
    ) {
      const transport = gateTransport({ [chatId]: state }, overrides);
      expect(await transport.stopGeneration(chatId)).toBe(true);
      return transport;
    }

    function send(
      transport: TriggerChatTransport,
      chatId: string,
      opts: {
        trigger?: "submit-message" | "regenerate-message";
        text?: string;
        abortSignal?: AbortSignal;
      } = {}
    ) {
      return transport.sendMessages({
        trigger: opts.trigger ?? "submit-message",
        chatId,
        messageId: undefined,
        messages: [createUserMessage(opts.text ?? "hi")],
        abortSignal: opts.abortSignal,
      });
    }

    // `.in` seq of the retried send. The stopped turn's boundary carries a lower
    // cursor, the new turn's carries this one.
    const RETRY_SEQ = 10;

    function mockFetch(outResponses: (() => Response)[]) {
      let subscribeCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          return new Response(JSON.stringify({ ok: true, seq: RETRY_SEQ }), { status: 200 });
        }
        if (isSessionOutSubscribeUrl(urlStr)) {
          const next = outResponses[Math.min(subscribeCount++, outResponses.length - 1)]!;
          return next();
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });
    }

    it("drops the stopped turn's tail and delivers the new turn after its turn-complete", async () => {
      mockFetch([
        () =>
          defaultSseResponse([
            // Tail of the stopped turn, then its boundary, then the new turn.
            { type: "text-delta", id: "old", delta: "stale" },
            { type: "text-end", id: "old" },
            { type: "trigger:turn-complete", sessionInEventId: RETRY_SEQ - 1 },
            { type: "text-start", id: "new" },
            { type: "text-delta", id: "new", delta: "fresh" },
            { type: "text-end", id: "new" },
            { type: "trigger:turn-complete", sessionInEventId: RETRY_SEQ },
          ]),
      ]);

      const transport = await armedGate("chat-retry", {
        publicAccessToken: "p",
        isStreaming: true,
      });

      const stream = await send(transport, "chat-retry", { trigger: "regenerate-message" });

      expect(await drainChunks(stream)).toEqual([
        { type: "text-start", id: "new" },
        { type: "text-delta", id: "new", delta: "fresh" },
        { type: "text-end", id: "new" },
      ]);
    });

    it("leaves the turn in flight while the stopped turn never reaches its boundary", async () => {
      // No first-chunk event fires, so a caller's no-first-event deadline
      // would surface a retryable error.
      mockFetch([
        () =>
          settled(
            defaultSseResponse([
              { type: "text-delta", id: "old", delta: "stale" },
              { type: "text-end", id: "old" },
            ])
          ),
      ]);

      const events: ChatTransportEvent[] = [];
      const transport = await armedGate(
        "chat-orphan",
        { publicAccessToken: "p", isStreaming: true },
        { onEvent: (e) => events.push(e) }
      );

      const stream = await send(transport, "chat-orphan");

      expect(await drainChunks(stream)).toEqual([]);
      expect(events.some((e) => e.type === "first-chunk")).toBe(false);
      expect(events.some((e) => e.type === "turn-completed")).toBe(false);
      expect(transport.getSession("chat-orphan")?.activeInputSeq).toBe(RETRY_SEQ);
    });

    it("keeps gating until the superseded turn's own boundary", async () => {
      // `.in` seq of the turn being stopped; an even older boundary can only be
      // a replay and must not reopen the gate.
      const STOPPED_SEQ = 5;
      mockFetch([
        () =>
          defaultSseResponse([
            { type: "text-delta", id: "old", delta: "stale" },
            { type: "trigger:turn-complete", sessionInEventId: STOPPED_SEQ - 2 },
            { type: "text-delta", id: "old", delta: "still stale" },
            { type: "trigger:turn-complete", sessionInEventId: STOPPED_SEQ },
            { type: "text-delta", id: "new", delta: "fresh" },
            { type: "trigger:turn-complete", sessionInEventId: RETRY_SEQ },
          ]),
      ]);

      const events: ChatTransportEvent[] = [];
      const transport = await armedGate(
        "chat-replayed-boundary",
        { publicAccessToken: "p", isStreaming: true, activeInputSeq: STOPPED_SEQ },
        { onEvent: (e) => events.push(e) }
      );

      const stream = await send(transport, "chat-replayed-boundary");

      expect(await drainChunks(stream)).toEqual([
        { type: "text-delta", id: "new", delta: "fresh" },
      ]);
      expect(events.filter((e) => e.type === "turn-completed")).toHaveLength(1);
    });

    it("lets a pending-version through while the gate is armed", async () => {
      // The handover the gate is waiting on is exactly when the successor can
      // land on a deployment that has not built yet.
      mockFetch([
        () =>
          defaultSseResponse([
            { type: "text-delta", id: "old", delta: "stale" },
            { type: "trigger:pending-version" },
            { type: "trigger:turn-complete", sessionInEventId: RETRY_SEQ - 1 },
            { type: "trigger:turn-complete", sessionInEventId: RETRY_SEQ },
          ]),
      ]);

      const events: ChatTransportEvent[] = [];
      const transport = await armedGate(
        "chat-gated-pending",
        { publicAccessToken: "p", isStreaming: true, activeInputSeq: 5 },
        { onEvent: (e) => events.push(e) }
      );

      const stream = await send(transport, "chat-gated-pending");
      expect(await drainChunks(stream)).toEqual([]);
      expect(events.filter((e) => e.type === "run-pending-version")).toHaveLength(1);
    });

    it("clears the gate on a header-less boundary (legacy wire)", async () => {
      // No cursor to compare, so the boundary is taken as the superseded turn's:
      // the tail is dropped, the turn closes, and the next send is not gated.
      mockFetch([
        () =>
          defaultSseResponse([
            { type: "text-delta", id: "old", delta: "stale" },
            { type: "trigger:turn-complete" },
          ]),
        () => defaultSseResponse(),
      ]);

      const transport = await armedGate("chat-legacy-boundary", {
        publicAccessToken: "p",
        isStreaming: true,
        activeInputSeq: 5,
      });

      const stream = await send(transport, "chat-legacy-boundary");
      expect(await drainChunks(stream)).toEqual([]);

      const next = await send(transport, "chat-legacy-boundary", { text: "again" });
      expect(await drainChunks(next)).toEqual(sampleChunks);
    });

    it("does not gate a stop with no turn outstanding", async () => {
      mockFetch([() => defaultSseResponse()]);

      const transport = await armedGate("chat-idle-stop", { publicAccessToken: "p" });

      const stream = await send(transport, "chat-idle-stop");

      expect(await drainChunks(stream)).toEqual(sampleChunks);
    });

    it("does not arm or write a stop when the abort lands after the boundary", async () => {
      const bodies: string[] = [];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          bodies.push(init!.body as string);
          return new Response(JSON.stringify({ ok: true, seq: RETRY_SEQ }), { status: 200 });
        }
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const controller = new AbortController();
      const transport = gateTransport({ "chat-late-abort": { publicAccessToken: "p" } });

      const stream = await send(transport, "chat-late-abort", { abortSignal: controller.signal });
      expect(await drainChunks(stream)).toEqual(sampleChunks);

      // The turn is over; the consumer dropping the stream must not gate the next.
      controller.abort();
      expect(bodies.some((b) => JSON.parse(b).kind === "stop")).toBe(false);

      const next = await send(transport, "chat-late-abort", { text: "again" });
      expect(await drainChunks(next)).toEqual(sampleChunks);
    });

    it("moves the saved cursor past a lost turn's records in hold mode", async () => {
      // Catches: the lost-output error leaving a hold-mode reader's saved cursor
      // behind the records it had read (it only catches up at a boundary the reader
      // goes on past), so the next reader re-read the swallowed turn.
      mockFetch([
        () =>
          defaultSseResponse([
            { type: "text-delta", id: "old", delta: "stale" },
            { type: "text-start", id: "new" },
            { type: "trigger:turn-complete", sessionInEventId: RETRY_SEQ },
          ]),
      ]);
      const persisted: ChatSessionPersistedState[] = [];
      const transport = await armedGate(
        "chat-lost-cursor",
        { publicAccessToken: "p", isStreaming: true },
        { onSessionChange: (_chatId, session) => session && persisted.push(session) }
      );

      const stream = await send(transport, "chat-lost-cursor");

      await expect(drainChunks(stream)).rejects.toThrow(/output was lost/);
      // The lost turn's boundary is the third record.
      expect(transport.getSession("chat-lost-cursor")?.lastEventId).toBe("3");
      expect(persisted.at(-1)?.lastEventId).toBe("3");
      transport.dispose();
    });

    it("errors the turn when the gate swallowed the new turn's own output", async () => {
      // The stopped run died without writing a boundary, so the gate ate the new
      // turn: surface an error rather than complete an empty answer.
      mockFetch([
        () =>
          defaultSseResponse([
            { type: "text-delta", id: "old", delta: "stale" },
            { type: "text-start", id: "new" },
            { type: "trigger:turn-complete", sessionInEventId: RETRY_SEQ },
          ]),
        () => defaultSseResponse(),
      ]);

      const events: ChatTransportEvent[] = [];
      const transport = await armedGate(
        "chat-no-old-boundary",
        { publicAccessToken: "p", isStreaming: true },
        { onEvent: (e) => events.push(e) }
      );

      const stream = await send(transport, "chat-no-old-boundary");

      await expect(drainChunks(stream)).rejects.toThrow(/output was lost/);
      expect(events.some((e) => e.type === "turn-completed")).toBe(false);
      expect(events.some((e) => e.type === "stream-error")).toBe(true);
      expect(transport.getSession("chat-no-old-boundary")?.isStreaming).toBe(false);
      expect(transport.getSession("chat-no-old-boundary")?.activeInputSeq).toBeUndefined();

      // Nothing left armed: the next send streams normally.
      const next = await send(transport, "chat-no-old-boundary", { text: "again" });
      expect(await drainChunks(next)).toEqual(sampleChunks);
    });

    it("delivers records again after clearSupersedeGate", async () => {
      mockFetch([() => defaultSseResponse()]);

      const transport = await armedGate("chat-escape", {
        publicAccessToken: "p",
        isStreaming: true,
      });
      transport.clearSupersedeGate("chat-escape");

      const stream = await send(transport, "chat-escape");

      expect(await drainChunks(stream)).toEqual(sampleChunks);
    });

    it("does not re-arm the gate when a retry stops a turn the deadline abandoned", async () => {
      const outResponses = [
        () =>
          defaultSseResponse([
            { type: "text-start", id: "new" },
            { type: "text-delta", id: "new", delta: "hello" },
            { type: "text-end", id: "new" },
            { type: "trigger:turn-complete", sessionInEventId: 11 },
          ]),
        () => settled(defaultSseResponse([{ type: "text-delta", id: "b", delta: "partial" }])),
        () =>
          defaultSseResponse([
            { type: "text-delta", id: "b", delta: "stale" },
            { type: "trigger:turn-complete", sessionInEventId: 12 },
            { type: "text-delta", id: "c", delta: "after" },
            { type: "trigger:turn-complete", sessionInEventId: 14 },
          ]),
      ];
      let appendSeq = 9;
      let subscribeCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          return new Response(JSON.stringify({ ok: true, seq: ++appendSeq }), { status: 200 });
        }
        if (isSessionOutSubscribeUrl(urlStr)) {
          return outResponses[Math.min(subscribeCount++, outResponses.length - 1)]!();
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = gateTransport({
        "chat-abandoned": { publicAccessToken: "p", isStreaming: true, activeInputSeq: 5 },
      });

      transport.clearSupersedeGate("chat-abandoned");
      expect(await transport.stopGeneration("chat-abandoned")).toBe(true);

      const retry = await send(transport, "chat-abandoned", { text: "retry" });

      expect(await drainChunks(retry)).toEqual([
        { type: "text-start", id: "new" },
        { type: "text-delta", id: "new", delta: "hello" },
        { type: "text-end", id: "new" },
      ]);

      // The abandoned turn is behind us: a later stop must gate again as usual.
      const next = await send(transport, "chat-abandoned", { text: "next" });
      expect(await drainChunks(next)).toEqual([{ type: "text-delta", id: "b", delta: "partial" }]);

      expect(await transport.stopGeneration("chat-abandoned")).toBe(true);

      const afterStop = await send(transport, "chat-abandoned", { text: "again" });

      expect(await drainChunks(afterStop)).toEqual([
        { type: "text-delta", id: "c", delta: "after" },
      ]);
    });

    it("keeps the gate out of the persisted session", async () => {
      mockFetch([() => defaultSseResponse()]);

      const sessions: Record<string, unknown> = {};
      const transport = await armedGate(
        "chat-persist",
        { publicAccessToken: "p" },
        {
          onSessionChange: (chatId, session) => {
            sessions[chatId] = session;
          },
        }
      );

      expect(transport.getSession("chat-persist")).not.toHaveProperty("skipToTurnComplete");
      expect(sessions["chat-persist"]).not.toHaveProperty("skipToTurnComplete");
    });

    it("starts a retried turn after the stopped one once the stopped turn's boundary is read", async () => {
      // Catches: the retry's turnStart staying inside the stopped turn, so a rewind
      // or a reload after the gate cleared replayed the stopped turn's tail (a
      // text-delta with no text-start) ahead of the retried reply, with nothing
      // left to gate it.
      const sseHeaders = { "content-type": "text/event-stream", "X-Stream-Version": "v2" };
      const cursors: Array<string | null> = [];
      // Records 1..4: the stopped turn's tail, its boundary, then the new turn,
      // which is still running (record 4). Records 5 and 6 (its text and its
      // turn-complete) are written only after the first send was read, so the
      // reloaded tab sees the finished retry.
      const records = JSON.parse(
        sseEncode([
          { type: "text-delta", id: "old", delta: "stale" },
          { type: "text-end", id: "old" },
          { type: "trigger:turn-complete", sessionInEventId: RETRY_SEQ - 1 },
          { type: "text-start", id: "new" },
          { type: "text-delta", id: "new", delta: "retried" },
          { type: "trigger:turn-complete", sessionInEventId: RETRY_SEQ },
        ]).match(/^data: (.*)$/m)![1]!
      ).records as Array<{ seq_num: number }>;
      let available = 4;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          return new Response(JSON.stringify({ ok: true, seq: RETRY_SEQ }), { status: 200 });
        }
        if (!isSessionOutSubscribeUrl(urlStr)) throw new Error(`Unexpected URL: ${urlStr}`);
        const cursor = new Headers(init?.headers).get("Last-Event-ID");
        cursors.push(cursor);
        const signal = init?.signal;
        const served = records.filter(
          (r) => r.seq_num > Number(cursor ?? 0) && r.seq_num <= available
        );
        const batch = `event: batch\ndata: ${JSON.stringify({ records: served })}\n\n`;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(batch));
            const onAbort = () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              try {
                controller.error(err);
              } catch {
                /* already errored */
              }
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          },
        });
        return new Response(body, { status: 200, headers: sseHeaders });
      });

      const persisted: ChatSessionPersistedState[] = [];
      const transport = await armedGate(
        "chat-retry-persist",
        { publicAccessToken: "p", lastEventId: "0", isStreaming: true },
        { onSessionChange: (_chatId, session) => session && persisted.push(session) }
      );

      const stream = await send(transport, "chat-retry-persist");
      const reader = stream.getReader();
      // The first chunk delivered is the new turn's: the stopped tail is gone.
      expect((await reader.read()).value).toEqual({ type: "text-start", id: "new" });

      // The boundary of the stopped turn is record 3.
      expect(transport.getSession("chat-retry-persist")?.lastEventId).toBe("3");
      expect(persisted.at(-1)?.lastEventId).toBe("3");

      const reloaded = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: { "chat-retry-persist": transport.getSession("chat-retry-persist")! },
      });
      available = 6;
      const resumed = await reloaded.reconnectToStream({ chatId: "chat-retry-persist" });
      expect(resumed).not.toBeNull();
      expect(cursors.at(-1)).toBe("3");

      // The reload gets the retried reply from its start, and none of the stopped
      // turn's tail.
      const [forMessage, forChunks] = resumed!.tee();
      let message: UIMessage | undefined;
      for await (const m of readUIMessageStream({ stream: forMessage })) message = m;
      expect(await drainChunks(forChunks)).toEqual([
        { type: "text-start", id: "new" },
        { type: "text-delta", id: "new", delta: "retried" },
      ]);
      expect(message?.parts.find((p) => p.type === "text")).toMatchObject({ text: "retried" });

      transport.dispose();
      reloaded.dispose();
    });

    it("starts a retried turn after the stopped one in hold mode too (no saved cursor)", async () => {
      // Catches: with no `.out` cursor the retry's reader holds chunks, so the state's
      // cursor lags the read position, and the gate clearing moved the turn start to
      // that stale cursor: a reload before the retry finished resumed from the start
      // of the window and replayed the stopped turn's tail ahead of the retried reply.
      const sseHeaders = { "content-type": "text/event-stream", "X-Stream-Version": "v2" };
      const cursors: Array<string | null> = [];
      // Records 1..3: the stopped turn's tail and its boundary; 4 the retry's first
      // chunk, still running. Records 5 and 6 come after the first read.
      const records = JSON.parse(
        sseEncode([
          { type: "text-delta", id: "old", delta: "stale" },
          { type: "text-end", id: "old" },
          { type: "trigger:turn-complete", sessionInEventId: RETRY_SEQ - 1 },
          { type: "text-start", id: "new" },
          { type: "text-delta", id: "new", delta: "retried" },
          { type: "trigger:turn-complete", sessionInEventId: RETRY_SEQ },
        ]).match(/^data: (.*)$/m)![1]!
      ).records as Array<{ seq_num: number }>;
      let available = 4;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          return new Response(JSON.stringify({ ok: true, seq: RETRY_SEQ }), { status: 200 });
        }
        if (!isSessionOutSubscribeUrl(urlStr)) throw new Error(`Unexpected URL: ${urlStr}`);
        const cursor = new Headers(init?.headers).get("Last-Event-ID");
        cursors.push(cursor);
        const signal = init?.signal;
        const served = records.filter(
          (r) => r.seq_num > Number(cursor ?? 0) && r.seq_num <= available
        );
        const batch = `event: batch\ndata: ${JSON.stringify({ records: served })}\n\n`;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(batch));
            const onAbort = () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              try {
                controller.error(err);
              } catch {
                /* already errored */
              }
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          },
        });
        return new Response(body, { status: 200, headers: sseHeaders });
      });

      const persisted: ChatSessionPersistedState[] = [];
      const transport = await armedGate(
        "chat-retry-hold",
        { publicAccessToken: "p", isStreaming: true },
        { onSessionChange: (_chatId, session) => session && persisted.push(session) }
      );

      const stream = await send(transport, "chat-retry-hold");
      const reader = stream.getReader();
      // The retry's chunk is held (no turn marker says it is the retry's) until its
      // boundary, so the reader is pending while the gate has already cleared.
      await vi.waitFor(() =>
        expect(persisted.at(-1)).toMatchObject({ isStreaming: true, lastEventId: "3" })
      );

      const reloaded = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: { "chat-retry-hold": persisted.at(-1)! },
      });
      available = 6;
      const resumed = await reloaded.reconnectToStream({ chatId: "chat-retry-hold" });
      expect(resumed).not.toBeNull();
      expect(cursors.at(-1)).toBe("3");

      const [forMessage, forChunks] = resumed!.tee();
      let message: UIMessage | undefined;
      for await (const m of readUIMessageStream({ stream: forMessage })) message = m;
      expect(await drainChunks(forChunks)).toEqual([
        { type: "text-start", id: "new" },
        { type: "text-delta", id: "new", delta: "retried" },
      ]);
      expect(message?.parts.find((p) => p.type === "text")).toMatchObject({ text: "retried" });

      transport.dispose();
      reloaded.dispose();
      await reader.cancel().catch(() => {});
    });

    it("clears on the first turn-complete after two consecutive stops", async () => {
      mockFetch([
        () =>
          defaultSseResponse([
            { type: "text-delta", id: "old", delta: "stale" },
            { type: "trigger:turn-complete", sessionInEventId: RETRY_SEQ - 1 },
            { type: "text-start", id: "new" },
            { type: "trigger:turn-complete", sessionInEventId: RETRY_SEQ },
          ]),
      ]);

      const transport = await armedGate("chat-double-stop", {
        publicAccessToken: "p",
        isStreaming: true,
      });
      expect(await transport.stopGeneration("chat-double-stop")).toBe(true);

      const stream = await send(transport, "chat-double-stop");

      expect(await drainChunks(stream)).toEqual([{ type: "text-start", id: "new" }]);
    });
  });

  describe("sendAction", () => {
    it("posts an action chunk to .in/append and subscribes to .out", async () => {
      let actionBody: any;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          actionBody = JSON.parse(init!.body as string);
          return defaultAppendResponse();
        }
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: { "chat-act": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendAction("chat-act", { type: "undo" });
      await drainChunks(stream);

      expect(actionBody.kind).toBe("message");
      expect(actionBody.payload.trigger).toBe("action");
      expect(actionBody.payload.action).toEqual({ type: "undo" });
    });

    it("sends a useChat request carrying body.action as an action", async () => {
      // `useChatActions` and `regenerate({ body })` reach the transport through
      // `sendMessages`; the action has to go out as an action, not a message,
      // and the response comes back on the request useChat made.
      let actionBody: any;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          actionBody = JSON.parse(init!.body as string);
          return defaultAppendResponse();
        }
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: { "chat-act-body": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-act-body",
        messageId: undefined,
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
        abortSignal: undefined,
        body: { action: { type: "regenerate" } },
        metadata: { tenant: "t-1" },
      });
      await drainChunks(stream);

      expect(actionBody.payload.trigger).toBe("action");
      expect(actionBody.payload.action).toEqual({ type: "regenerate" });
      expect(actionBody.payload.message).toBeUndefined();
      // The request's own metadata rides along, not only the transport defaults.
      expect(actionBody.payload.metadata).toEqual({ tenant: "t-1" });
    });

    it("merges per-action metadata over the transport's clientData", async () => {
      let actionBody: any;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          actionBody = JSON.parse(init!.body as string);
          return defaultAppendResponse();
        }
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: { "chat-act-meta": { publicAccessToken: "p" } },
        clientData: { userId: "u1", scope: "default" } as Record<string, unknown>,
      });

      const stream = await transport.sendAction(
        "chat-act-meta",
        { type: "undo" },
        { metadata: { scope: "action" } }
      );
      await drainChunks(stream);

      expect(actionBody.payload.metadata).toEqual({ userId: "u1", scope: "action" });
    });

    it("marks the session streaming and notifies before subscribing", async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          return new Response(JSON.stringify({ ok: true, seq: 7 }), { status: 200 });
        }
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const onSessionChange = vi.fn();
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        onSessionChange,
        sessions: { "chat-act-stream": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendAction("chat-act-stream", { type: "undo" });
      // isStreaming:true must be observed during the action — otherwise a reload
      // mid-action sees a persisted isStreaming:false and never resumes.
      expect(
        onSessionChange.mock.calls.some(
          ([, session]) => session && session.isStreaming === true && session.activeInputSeq === 7
        )
      ).toBe(true);
      await drainChunks(stream);
    });
  });

  describe("append idempotency header", () => {
    it("the per-append X-Part-Id wins over a transport-wide headers override", async () => {
      let appendPartId: string | undefined;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          appendPartId = (init!.headers as Record<string, string>)["X-Part-Id"];
          return defaultAppendResponse();
        }
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        headers: { "X-Part-Id": "STATIC-OVERRIDE" },
        sessions: { "chat-hdr": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-hdr",
        messageId: undefined,
        messages: [createUserMessage("hi")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      expect(appendPartId).toBeDefined();
      expect(appendPartId).not.toBe("STATIC-OVERRIDE");
    });
  });

  describe("reconnectToStream", () => {
    it("returns null when no session exists", async () => {
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
      });
      const result = await transport.reconnectToStream({ chatId: "missing" });
      expect(result).toBeNull();
    });

    it("returns null when the session is hydrated with isStreaming=false", async () => {
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: {
          "chat-rc": { publicAccessToken: "p", isStreaming: false },
        },
      });
      const result = await transport.reconnectToStream({ chatId: "chat-rc" });
      expect(result).toBeNull();
    });

    it("resumes in watch mode when the session is hydrated with isStreaming=false", async () => {
      let subscribeCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionOutSubscribeUrl(urlStr)) {
          subscribeCount++;
          const response = defaultSseResponse([{ type: "text-delta", id: "p1", delta: "turn2" }]);
          const headers = new Headers(response.headers);
          headers.set("X-Session-Settled", "true");
          return new Response(response.body, { status: 200, headers });
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        watch: true,
        sessions: {
          "chat-rc-watch": { publicAccessToken: "p", isStreaming: false },
        },
      });

      const stream = await transport.reconnectToStream({ chatId: "chat-rc-watch" });
      expect(stream).not.toBeNull();
      const chunks = await drainChunks(stream!);

      expect(subscribeCount).toBe(1);
      expect(chunks).toEqual([{ type: "text-delta", id: "p1", delta: "turn2" }]);
    });

    it("opens an SSE subscription with the X-Peek-Settled header set", async () => {
      let subscribeHeaders: Headers | undefined;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionOutSubscribeUrl(urlStr)) {
          subscribeHeaders = new Headers(init?.headers);
          return defaultSseResponse();
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: {
          "chat-rc-on": { publicAccessToken: "p", isStreaming: true },
        },
      });

      const stream = await transport.reconnectToStream({ chatId: "chat-rc-on" });
      expect(stream).not.toBeNull();
      await drainChunks(stream!);

      expect(subscribeHeaders?.get("X-Peek-Settled")).toBe("1");
    });
  });

  describe("stream body ends mid-turn", () => {
    it("resubscribes from the last event id when the close was not settled", async () => {
      const subscribeHeaders: Headers[] = [];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) {
          subscribeHeaders.push(new Headers(init?.headers));
          // First connection ends mid-turn: one chunk, no turn-complete,
          // no `X-Session-Settled`.
          return subscribeHeaders.length === 1
            ? defaultSseResponse([{ type: "text-start", id: "part-1" }])
            : defaultSseResponse([
                { type: "text-delta", id: "part-1", delta: "resumed" },
                { type: "trigger:turn-complete" },
              ]);
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: { "chat-eof": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-eof",
        messageId: undefined,
        messages: [createUserMessage("hi")],
        abortSignal: undefined,
      });
      const chunks = await drainChunks(stream);

      expect(subscribeHeaders).toHaveLength(2);
      expect(subscribeHeaders[1]?.get("Last-Event-ID")).toBe("1");
      expect(chunks).toEqual([
        { type: "text-start", id: "part-1" },
        { type: "text-delta", id: "part-1", delta: "resumed" },
      ]);
      expect(transport.getSession("chat-eof")?.isStreaming).toBe(false);
    });

    it("stops and clears isStreaming when the close was settled", async () => {
      let subscribeCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) {
          subscribeCount++;
          const response = defaultSseResponse([{ type: "text-start", id: "part-1" }]);
          const headers = new Headers(response.headers);
          headers.set("X-Session-Settled", "true");
          return new Response(response.body, { status: 200, headers });
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const onSessionChange = vi.fn();
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        onSessionChange,
        sessions: { "chat-settled": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-settled",
        messageId: undefined,
        messages: [createUserMessage("hi")],
        abortSignal: undefined,
      });
      await drainChunks(stream);

      expect(subscribeCount).toBe(1);
      expect(transport.getSession("chat-settled")?.isStreaming).toBe(false);
      expect(
        onSessionChange.mock.calls.some(([, session]) => session && session.isStreaming === false)
      ).toBe(true);
    });

    it("keeps streaming when every window delivers a single record", async () => {
      // One record per window arrives via `primed` on the resumed connection —
      // it must still re-earn the budget, otherwise a slow turn is truncated.
      const WINDOWS = 8;
      let subscribeCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) {
          subscribeCount++;
          return subscribeCount > WINDOWS
            ? defaultSseResponse([{ type: "trigger:turn-complete" }])
            : defaultSseResponse([
                { type: "text-delta", id: "part-1", delta: `d${subscribeCount}` },
              ]);
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: { "chat-slow": { publicAccessToken: "p" } },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-slow",
        messageId: undefined,
        messages: [createUserMessage("hi")],
        abortSignal: undefined,
      });
      const chunks = await drainChunks(stream);

      expect(subscribeCount).toBe(WINDOWS + 1);
      expect(chunks).toHaveLength(WINDOWS);
      expect(transport.getSession("chat-slow")?.isStreaming).toBe(false);
    });

    it("surfaces an error after the resubscribe budget is exhausted", async () => {
      // Fake timers so the 100ms..1.6s backoffs don't cost real seconds.
      vi.useFakeTimers();
      try {
        let subscribeCount = 0;
        global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
          if (isSessionOutSubscribeUrl(urlStr)) {
            subscribeCount++;
            // Never any records, never settled — the pathological case.
            return defaultSseResponse([]);
          }
          throw new Error(`Unexpected URL: ${urlStr}`);
        });

        const transport = new TriggerChatTransport({
          task: "my-chat-task",
          accessToken: () => "pat",
          sessions: { "chat-empty": { publicAccessToken: "p" } },
        });

        const stream = await transport.sendMessages({
          trigger: "submit-message",
          chatId: "chat-empty",
          messageId: undefined,
          messages: [createUserMessage("hi")],
          abortSignal: undefined,
        });
        // A cut-off turn surfaces an error rather than reading as complete.
        // Attach the rejection assertion before advancing timers so the
        // rejection is never unhandled.
        const drained = drainChunks(stream);
        const rejects = expect(drained).rejects.toThrow(/reconnect budget exhausted/i);
        await vi.advanceTimersByTimeAsync(10_000);
        await rejects;

        // One initial connect plus the five-attempt resubscribe budget.
        expect(subscribeCount).toBe(6);
        // State is cleared before the throw, so a reload won't reopen a
        // doomed subscription.
        expect(transport.getSession("chat-empty")?.isStreaming).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("watch mode across long-poll window boundaries", () => {
    function settled(response: Response): Response {
      const headers = new Headers(response.headers);
      headers.set("X-Session-Settled", "true");
      return new Response(response.body, { status: 200, headers });
    }

    it("resubscribes after a completed turn and receives a later wake", async () => {
      let subscribeCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionOutSubscribeUrl(urlStr)) {
          subscribeCount++;
          // Window 1: a turn completes, then the body EOFs with no
          // settled header — the quiet long-poll boundary.
          return subscribeCount === 1
            ? defaultSseResponse([
                { type: "text-delta", id: "p1", delta: "turn1" },
                { type: "trigger:turn-complete" },
              ])
            : settled(defaultSseResponse([{ type: "text-delta", id: "p2", delta: "wake" }]));
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        watch: true,
        sessions: { "chat-watch-eof": { publicAccessToken: "p", isStreaming: true } },
      });

      const stream = await transport.reconnectToStream({ chatId: "chat-watch-eof" });
      const chunks = await drainChunks(stream!);

      expect(subscribeCount).toBe(2);
      expect(chunks).toEqual([
        { type: "text-delta", id: "p1", delta: "turn1" },
        { type: "text-delta", id: "p2", delta: "wake" },
      ]);
    });

    it("does not peek-settle an idle resubscribe, so the next turn is delivered", async () => {
      // Watch mode must NOT send X-Peek-Settled between turns: a settled peek
      // while no turn is in flight closes the standing subscription and the
      // viewer never sees turn 2. This mock plays the server's peek shortcut —
      // a peek request with nothing in flight settles — to prove the transport
      // long-polls instead.
      const subscribeHeaders: Headers[] = [];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionOutSubscribeUrl(urlStr)) {
          subscribeHeaders.push(new Headers(init?.headers));
          const n = subscribeHeaders.length;
          if (n === 1) {
            // Turn 1 completes, then the body EOFs (no settled header).
            return defaultSseResponse([
              { type: "text-delta", id: "p1", delta: "turn1" },
              { type: "trigger:turn-complete" },
            ]);
          }
          if (n === 2) {
            // Idle resubscribe. If it peeked, the server settles and the
            // subscription would close before turn 2; a long-poll delivers it.
            if (init && new Headers(init.headers).get("X-Peek-Settled")) {
              return settled(defaultSseResponse([]));
            }
            return defaultSseResponse([
              { type: "text-delta", id: "p2", delta: "turn2" },
              { type: "trigger:turn-complete" },
            ]);
          }
          // Turn 2 done — end the watch cleanly.
          return settled(defaultSseResponse([]));
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        watch: true,
        sessions: { "chat-watch-turn2": { publicAccessToken: "p", isStreaming: true } },
      });

      const stream = await transport.reconnectToStream({ chatId: "chat-watch-turn2" });
      const chunks = await drainChunks(stream!);

      expect(subscribeHeaders[1]?.get("X-Peek-Settled")).toBeNull();
      expect(chunks).toEqual([
        { type: "text-delta", id: "p1", delta: "turn1" },
        { type: "text-delta", id: "p2", delta: "turn2" },
      ]);
    });

    it("cancelling the reader stops the resubscribe loop", async () => {
      // A consumer that stops reading without aborting must not leak the
      // resubscribe loop — the stream's cancel() aborts it.
      vi.useFakeTimers();
      try {
        let subscribeCount = 0;
        global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (isSessionOutSubscribeUrl(urlStr)) {
            subscribeCount++;
            // Quiet: EOF, no records, never settled — watch keeps resubscribing.
            return defaultSseResponse([]);
          }
          throw new Error(`Unexpected URL: ${urlStr}`);
        });

        const events: ChatTransportEvent[] = [];
        const transport = new TriggerChatTransport({
          task: "my-chat-task",
          accessToken: () => "pat",
          watch: true,
          onEvent: (e) => events.push(e),
          sessions: { "chat-watch-cancel": { publicAccessToken: "p", isStreaming: true } },
        });

        const stream = await transport.reconnectToStream({ chatId: "chat-watch-cancel" });
        const reader = stream!.getReader();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(subscribeCount).toBeGreaterThan(1);

        const countAtCancel = subscribeCount;
        await reader.cancel();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(subscribeCount).toBe(countAtCancel);
        // A clean cancel must not surface a spurious stream-error (an
        // unguarded controller.close() after cancel would throw "Invalid
        // state" and leak it onto the telemetry channel).
        expect(events.some((e) => e.type === "stream-error")).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops when the server says the session settled", async () => {
      let subscribeCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionOutSubscribeUrl(urlStr)) {
          subscribeCount++;
          return settled(
            defaultSseResponse([
              { type: "text-delta", id: "p1", delta: "last" },
              { type: "trigger:turn-complete" },
            ])
          );
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        watch: true,
        sessions: { "chat-watch-settled": { publicAccessToken: "p", isStreaming: true } },
      });

      const stream = await transport.reconnectToStream({ chatId: "chat-watch-settled" });
      const chunks = await drainChunks(stream!);

      expect(subscribeCount).toBe(1);
      expect(chunks).toHaveLength(1);
      expect(transport.getSession("chat-watch-settled")?.isStreaming).toBe(false);
    });

    it("stops promptly when aborted during backoff", async () => {
      vi.useFakeTimers();
      try {
        let subscribeCount = 0;
        global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
          if (isSessionOutSubscribeUrl(urlStr)) {
            subscribeCount++;
            // Every window is quiet: EOF with no records, never settled.
            return defaultSseResponse([]);
          }
          throw new Error(`Unexpected URL: ${urlStr}`);
        });

        const abortController = new AbortController();
        const transport = new TriggerChatTransport({
          task: "my-chat-task",
          accessToken: () => "pat",
          watch: true,
          sessions: { "chat-watch-abort": { publicAccessToken: "p", isStreaming: true } },
        });

        const stream = await transport.reconnectToStream({
          chatId: "chat-watch-abort",
          abortSignal: abortController.signal,
        });
        const drained = drainChunks(stream!);
        await vi.advanceTimersByTimeAsync(10_000);
        // The budget doesn't apply in watch mode, so it is still reconnecting.
        expect(subscribeCount).toBeGreaterThan(6);

        const countAtAbort = subscribeCount;
        abortController.abort();
        await drained;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(subscribeCount).toBe(countAtAbort);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("reconnectToStream stop-on-abort ownership (TRI-13070)", () => {
    // A quiet stream: EOF, no records, never settled — the subscription
    // stays alive (watch mode) so an abort mid-flight exercises the stop path.
    function quietWatchTransport(): {
      transport: TriggerChatTransport;
      appends: () => number;
    } {
      let appendCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          appendCount++;
          return defaultAppendResponse();
        }
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse([]);
        throw new Error(`Unexpected URL: ${urlStr}`);
      });
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        watch: true,
        sessions: { "chat-own": { publicAccessToken: "p", isStreaming: true } },
      });
      return { transport, appends: () => appendCount };
    }

    it("passive subscriber aborting writes no stop chunk to .in", async () => {
      vi.useFakeTimers();
      try {
        const { transport, appends } = quietWatchTransport();
        const abort = new AbortController();
        const stream = await transport.reconnectToStream({
          chatId: "chat-own",
          abortSignal: abort.signal,
        });
        const drained = drainChunks(stream!);
        await vi.advanceTimersByTimeAsync(1_000);
        abort.abort();
        await drained;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(appends()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("owning subscriber with stopOnAbort:true sends a stop chunk on abort", async () => {
      vi.useFakeTimers();
      try {
        const { transport, appends } = quietWatchTransport();
        const abort = new AbortController();
        const stream = await transport.reconnectToStream({
          chatId: "chat-own",
          abortSignal: abort.signal,
          stopOnAbort: true,
        });
        const drained = drainChunks(stream!);
        await vi.advanceTimersByTimeAsync(1_000);
        abort.abort();
        await drained;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(appends()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("abortSignal presence alone (stopOnAbort unset) sends no stop", async () => {
      vi.useFakeTimers();
      try {
        const { transport, appends } = quietWatchTransport();
        const abort = new AbortController();
        const stream = await transport.reconnectToStream({
          chatId: "chat-own",
          abortSignal: abort.signal,
        });
        const drained = drainChunks(stream!);
        await vi.advanceTimersByTimeAsync(1_000);
        abort.abort();
        await drained;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(appends()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("reconnectToStream after the consumer aborted a resume", () => {
    // One record, then a connection that stays open until it is aborted: a
    // turn that is still running on the server when the consumer lets go.
    function openAfterChunk(signal?: AbortSignal | null): Response {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(sseEncode([{ type: "text-delta", id: "p1", delta: "hi" }]))
          );
          const onAbort = () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            try {
              controller.error(err);
            } catch {
              /* already errored */
            }
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream", "X-Stream-Version": "v2" },
      });
    }

    function runningTurnTransport(chatId: string, options: { multiTab?: boolean } = {}) {
      let appendCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          appendCount++;
          return defaultAppendResponse();
        }
        if (isSessionOutSubscribeUrl(urlStr)) return openAfterChunk(init?.signal);
        throw new Error(`Unexpected URL: ${urlStr}`);
      });
      const onSessionChange = vi.fn();
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        onSessionChange,
        multiTab: options.multiTab,
        sessions: { [chatId]: { publicAccessToken: "p", lastEventId: "5", isStreaming: true } },
      });
      return { transport, onSessionChange, appends: () => appendCount };
    }

    // Reads the first chunk so the subscription is connected, then returns a
    // function that finishes draining once the consumer has aborted.
    async function startReading(stream: ReadableStream<UIMessageChunk>) {
      const reader = stream.getReader();
      expect((await reader.read()).done).toBe(false);
      return async () => {
        while (!(await reader.read()).done) {
          /* drain */
        }
      };
    }

    it("hands out a new stream right after the consumer aborts the previous one", async () => {
      // Catches: the aborted stream still holds its activeStreams slot until its
      // fetch unwinds, so a remount's immediate resume got null.
      const { transport } = runningTurnTransport("chat-remount");
      const abort = new AbortController();
      const first = await transport.reconnectToStream({
        chatId: "chat-remount",
        abortSignal: abort.signal,
      });
      expect(first).not.toBeNull();
      const finish = await startReading(first!);

      abort.abort();
      const second = await transport.reconnectToStream({ chatId: "chat-remount" });
      expect(second).not.toBeNull();

      await finish();
      transport.dispose();
    });

    it("keeps the turn running after the aborted stream unwinds", async () => {
      // Catches: the abort was treated as the end of the turn, so isStreaming
      // and turnStart were cleared and persisted, and no later resume could
      // rejoin a turn that is still running.
      const { transport, onSessionChange } = runningTurnTransport("chat-keep");
      const abort = new AbortController();
      const first = await transport.reconnectToStream({
        chatId: "chat-keep",
        abortSignal: abort.signal,
      });
      const finish = await startReading(first!);
      onSessionChange.mockClear();

      abort.abort();
      await finish();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const persisted = transport.getSession("chat-keep");
      expect(persisted?.isStreaming).toBe(true);
      // The persisted cursor is the turn's start, not the chunk read since.
      expect(persisted?.lastEventId).toBe("5");
      expect(onSessionChange).not.toHaveBeenCalled();

      const resumed = await transport.reconnectToStream({ chatId: "chat-keep" });
      expect(resumed).not.toBeNull();
      transport.dispose();
    });

    it("still sends the stop and ends the turn when the owner aborts", async () => {
      // Catches: freeing the slot on abort must not stop an owning abort
      // (stopOnAbort) from writing its stop or from ending the turn.
      const { transport, onSessionChange, appends } = runningTurnTransport("chat-owner");
      const abort = new AbortController();
      const first = await transport.reconnectToStream({
        chatId: "chat-owner",
        abortSignal: abort.signal,
        stopOnAbort: true,
      });
      const finish = await startReading(first!);

      abort.abort();
      await finish();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(appends()).toBe(1);
      expect(transport.getSession("chat-owner")?.isStreaming).toBe(false);
      expect(onSessionChange).toHaveBeenCalledWith(
        "chat-owner",
        expect.objectContaining({ isStreaming: false })
      );
      transport.dispose();
    });

    it("replays a rejoined turn from its start after a consumer abort", async () => {
      // Catches: the abort left state.lastEventId at the last record the gone
      // reader consumed, so the next reader on the same transport resumed
      // mid-turn and got text-delta chunks with no text-start to attach to.
      const reply: UIMessageChunk[] = [
        { type: "start" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hel" },
        { type: "text-delta", id: "t1", delta: "lo" },
        { type: "text-delta", id: "t1", delta: " world" },
        { type: "text-end", id: "t1" },
      ];
      // Records 11..16, then the turn-complete control record as 17.
      const records = [
        ...reply.map((chunk, i) => ({
          body: JSON.stringify({ data: chunk, id: `p-${i}` }),
          seq_num: 11 + i,
          timestamp: 1700000000000 + i,
          headers: [] as Array<[string, string]>,
        })),
        {
          body: "",
          seq_num: 17,
          timestamp: 1700000000100,
          headers: [["trigger-control", "turn-complete"]] as Array<[string, string]>,
        },
      ];
      let available = 14; // the server has written up to "lo" so far
      const cursors: Array<string | null> = [];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (!isSessionOutSubscribeUrl(urlStr)) throw new Error(`Unexpected URL: ${urlStr}`);
        const cursor = new Headers(init?.headers).get("Last-Event-ID");
        cursors.push(cursor);
        const served = records.filter(
          (r) => r.seq_num > Number(cursor ?? 0) && r.seq_num <= available
        );
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `event: batch\ndata: ${JSON.stringify({ records: served })}\n\n`
              )
            );
            const onAbort = () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              try {
                controller.error(err);
              } catch {
                /* already errored */
              }
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "X-Stream-Version": "v2" },
        });
      });
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: {
          "chat-replay": { publicAccessToken: "p", lastEventId: "10", isStreaming: true },
        },
      });

      const abort = new AbortController();
      const first = await transport.reconnectToStream({
        chatId: "chat-replay",
        abortSignal: abort.signal,
      });
      const reader = first!.getReader();
      for (let i = 0; i < 4; i++) expect((await reader.read()).done).toBe(false);
      abort.abort();
      while (!(await reader.read()).done) {
        /* drain */
      }

      available = 17;
      const second = await transport.reconnectToStream({ chatId: "chat-replay" });
      expect(second).not.toBeNull();
      const [forMessage, forChunks] = second!.tee();
      let message: UIMessage | undefined;
      for await (const m of readUIMessageStream({ stream: forMessage })) message = m;
      const replayed = await drainChunks(forChunks);

      // The replacement asked for the turn start, not the last record read.
      expect(cursors).toEqual(["10", "10"]);
      expect(replayed.map((c) => c.type)).toEqual([
        "start",
        "text-start",
        "text-delta",
        "text-delta",
        "text-delta",
        "text-end",
      ]);
      expect(message?.parts.find((p) => p.type === "text")).toMatchObject({
        text: "Hello world",
      });
      transport.dispose();
    });

    it("starts a send after an aborted resume from the live cursor, not the turn start", async () => {
      // Catches: rewinding the cursor to the turn start when the consumer aborts, so
      // a send that follows (no stop written, no gate armed) subscribed from the
      // start of the old turn and rendered its whole reply into the new answer.
      const reply: UIMessageChunk[] = [
        { type: "start" },
        { type: "text-start", id: "t1" },
        { type: "text-delta", id: "t1", delta: "Hel" },
        { type: "text-delta", id: "t1", delta: "lo" },
      ];
      // Records 11..14: the turn is still running on the server.
      const records = reply.map((chunk, i) => ({
        body: JSON.stringify({ data: chunk, id: `p-${i}` }),
        seq_num: 11 + i,
        timestamp: 1700000000000 + i,
        headers: [] as Array<[string, string]>,
      }));
      const cursors: Array<string | null> = [];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (!isSessionOutSubscribeUrl(urlStr)) throw new Error(`Unexpected URL: ${urlStr}`);
        const cursor = new Headers(init?.headers).get("Last-Event-ID");
        cursors.push(cursor);
        const served = records.filter((r) => r.seq_num > Number(cursor ?? 0));
        const signal = init?.signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `event: batch\ndata: ${JSON.stringify({ records: served })}\n\n`
              )
            );
            const onAbort = () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              try {
                controller.error(err);
              } catch {
                /* already errored */
              }
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream", "X-Stream-Version": "v2" },
        });
      });
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        sessions: {
          "chat-send-after-abort": { publicAccessToken: "p", lastEventId: "10", isStreaming: true },
        },
      });

      const abort = new AbortController();
      const resumed = await transport.reconnectToStream({
        chatId: "chat-send-after-abort",
        abortSignal: abort.signal,
      });
      const reader = resumed!.getReader();
      for (let i = 0; i < 4; i++) expect((await reader.read()).done).toBe(false);
      abort.abort();
      while (!(await reader.read()).done) {
        /* drain */
      }

      await transport.sendMessages({
        trigger: "submit-message" as const,
        chatId: "chat-send-after-abort",
        messageId: undefined,
        messages: [createUserMessage("next")],
        abortSignal: undefined,
      });

      expect(cursors).toEqual(["10", "14"]);
      transport.dispose();
    });

    it("does not let an aborted resume free the slot or claim of the send that superseded it", async () => {
      // Catches: the consumer-abort listener freeing the activeStreams entry and
      // the tab claim without checking they are still its own, so a late abort of
      // a resume that a send already superseded would drop the send's slot (a
      // second resume would open a duplicate) and let another tab take the chat.
      const { transport, appends } = runningTurnTransport("chat-late-abort", { multiTab: true });

      const abort = new AbortController();
      const resumed = await transport.reconnectToStream({
        chatId: "chat-late-abort",
        abortSignal: abort.signal,
      });
      const finishResumed = await startReading(resumed!);

      const sent = await transport.sendMessages({
        trigger: "submit-message" as const,
        chatId: "chat-late-abort",
        messageId: undefined,
        messages: [createUserMessage("hi")],
        abortSignal: undefined,
      });
      const finishSent = await startReading(sent);
      await finishResumed();
      expect(transport.hasClaim("chat-late-abort")).toBe(true);

      abort.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(appends()).toBe(1);
      expect(transport.hasClaim("chat-late-abort")).toBe(true);
      expect(await transport.reconnectToStream({ chatId: "chat-late-abort" })).toBeNull();

      transport.dispose();
      await finishSent();
    });

    // A turn on `.out` as the server holds it: records 11..14, still running.
    const runningTurn = [
      { type: "start" },
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Hel" },
      { type: "text-delta", id: "t1", delta: "lo" },
    ].map((chunk, i) => ({
      body: JSON.stringify({ data: chunk, id: `p-${i}` }),
      seq_num: 11 + i,
      timestamp: 1700000000000 + i,
      headers: [] as Array<[string, string]>,
    }));

    // `.out` serves the running turn and stays open until aborted; `.out/records`
    // answers once `recordsGate` opens (or rejects when its signal aborts), with
    // the turn's first record as its start.
    function lookupTransport(
      chatId: string,
      session: ChatSessionPersistedState,
      options: { recordsGate?: Promise<void>; multiTab?: boolean } = {}
    ) {
      const outReads: Array<string | null> = [];
      let appendCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionStreamAppendUrl(urlStr)) {
          appendCount++;
          return defaultAppendResponse();
        }
        if (urlStr.includes("/out/records")) {
          const signal = init?.signal ?? undefined;
          if (options.recordsGate) {
            await new Promise<void>((resolve, reject) => {
              const abort = () => reject(new DOMException("aborted", "AbortError"));
              if (signal?.aborted) return abort();
              signal?.addEventListener("abort", abort, { once: true });
              options.recordsGate!.then(resolve, reject);
            });
          }
          return Response.json({ records: [] });
        }
        if (isSessionOutSubscribeUrl(urlStr)) {
          const cursor = new Headers(init?.headers).get("Last-Event-ID");
          outReads.push(cursor);
          const served = runningTurn.filter((r) => r.seq_num > Number(cursor ?? 0));
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `event: batch\ndata: ${JSON.stringify({ records: served })}\n\n`
                )
              );
              const onAbort = () => {
                const err = new Error("aborted");
                err.name = "AbortError";
                try {
                  controller.error(err);
                } catch {
                  /* already errored */
                }
              };
              if (init?.signal?.aborted) onAbort();
              else init?.signal?.addEventListener("abort", onAbort, { once: true });
            },
          });
          return new Response(body, {
            status: 200,
            headers: { "content-type": "text/event-stream", "X-Stream-Version": "v2" },
          });
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        multiTab: options.multiTab,
        sessions: { [chatId]: session },
      });
      return { transport, outReads, appends: () => appendCount };
    }

    // Reads `count` chunks of a stream that stays open, then lets go of it.
    async function drainChunksUntil(stream: ReadableStream<UIMessageChunk>, count: number) {
      const reader = stream.getReader();
      const out: UIMessageChunk[] = [];
      while (out.length < count) {
        const { done, value } = await reader.read();
        if (done) break;
        out.push(value);
      }
      reader.releaseLock();
      return out;
    }

    it("hands out a stream to a resume that follows an abort during the lookup, with a cursor", async () => {
      // Catches: a resume aborted between registering its controller and
      // subscribing (the lookup await yields even with a cursor) still held the
      // slot, so the remount's immediate resume got null: the StrictMode bug again.
      const { transport, appends } = lookupTransport("chat-strict", {
        publicAccessToken: "p",
        lastEventId: "10",
        isStreaming: true,
      });
      const abort = new AbortController();
      const first = transport.reconnectToStream({
        chatId: "chat-strict",
        abortSignal: abort.signal,
      });
      abort.abort();
      const second = await transport.reconnectToStream({ chatId: "chat-strict" });

      expect(second).not.toBeNull();
      expect(await first).toBeNull();
      const chunks = await drainChunksUntil(second!, 4);
      expect(chunks.map((c) => c.type)).toEqual([
        "start",
        "text-start",
        "text-delta",
        "text-delta",
      ]);
      expect(appends()).toBe(0);
      transport.dispose();
    });

    it("hands out a stream to a resume that follows an abort during a cursorless lookup", async () => {
      // Catches: the same bug when the lookup is a real `.out/records` page: the
      // aborted resume's slot stayed taken for as long as that request was in flight.
      let release!: () => void;
      const recordsGate = new Promise<void>((resolve) => (release = resolve));
      const { transport, outReads, appends } = lookupTransport(
        "chat-strict-lookup",
        { publicAccessToken: "p", isStreaming: true, activeInputSeq: 7 },
        { recordsGate }
      );
      const abort = new AbortController();
      const first = transport.reconnectToStream({
        chatId: "chat-strict-lookup",
        abortSignal: abort.signal,
      });
      await vi.waitFor(() => expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1));
      abort.abort();
      const second = transport.reconnectToStream({ chatId: "chat-strict-lookup" });
      release();

      expect(await first).toBeNull();
      const stream = await second;
      expect(stream).not.toBeNull();
      const chunks = await drainChunksUntil(stream!, 4);
      expect(chunks.map((c) => c.type)).toEqual([
        "start",
        "text-start",
        "text-delta",
        "text-delta",
      ]);
      expect(outReads).toHaveLength(1);
      expect(appends()).toBe(0);
      transport.dispose();
    });

    it("does not let an aborted resume take the slot or the claim back after its lookup (multi-tab)", async () => {
      // Catches: the stale resume, once its lookup settles, subscribing anyway or
      // freeing what is no longer its own: it replaced the send that took over the
      // chat (a second reader) or dropped that send's slot and tab claim.
      let release!: () => void;
      const recordsGate = new Promise<void>((resolve) => (release = resolve));
      const { transport, outReads, appends } = lookupTransport(
        "chat-stale",
        { publicAccessToken: "p", isStreaming: true, activeInputSeq: 7 },
        { recordsGate, multiTab: true }
      );
      const abort = new AbortController();
      const stale = transport.reconnectToStream({
        chatId: "chat-stale",
        abortSignal: abort.signal,
      });
      await vi.waitFor(() => expect(vi.mocked(global.fetch)).toHaveBeenCalledTimes(1));
      abort.abort();

      // Another resume takes the slot while the stale one's lookup is in flight:
      // the abort freed it, so it gets a stream rather than null.
      const next = transport.reconnectToStream({ chatId: "chat-stale" });
      release();
      expect(await stale).toBeNull();
      const stream = await next;
      expect(stream).not.toBeNull();

      // The stale resume left the new one's slot alone: its stream is live and
      // delivers the turn, and a further resume still finds the slot taken.
      const chunks = await drainChunksUntil(stream!, 4);
      expect(chunks.map((c) => c.type)).toEqual([
        "start",
        "text-start",
        "text-delta",
        "text-delta",
      ]);
      expect(await transport.reconnectToStream({ chatId: "chat-stale" })).toBeNull();
      expect(outReads).toHaveLength(1);
      expect(appends()).toBe(0);
      transport.dispose();
    });
  });

  describe("superseded stream teardown", () => {
    it("keeps the successor's controller registered when the aborted stream tears down", async () => {
      vi.useFakeTimers();
      try {
        let appendCount = 0;
        global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (isSessionStreamAppendUrl(urlStr)) {
            appendCount++;
            return defaultAppendResponse();
          }
          // Quiet stream: EOF, no records, never settled — watch keeps it open.
          if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse([]);
          throw new Error(`Unexpected URL: ${urlStr}`);
        });

        const transport = new TriggerChatTransport({
          task: "my-chat-task",
          accessToken: () => "pat",
          watch: true,
          sessions: { "chat-race": { publicAccessToken: "p", isStreaming: true } },
        });

        const send = () =>
          transport.sendMessages({
            trigger: "submit-message" as const,
            chatId: "chat-race",
            messageId: undefined,
            messages: [createUserMessage("hi")],
            abortSignal: undefined,
          });

        const first = drainChunks(await send());
        await vi.advanceTimersByTimeAsync(1_000);

        // Supersede: the new stream registers its controller synchronously,
        // the aborted one tears down a microtask later.
        const second = await send();
        let secondClosed = false;
        const secondDrain = drainChunks(second).then(() => {
          secondClosed = true;
        });
        await first;
        await vi.advanceTimersByTimeAsync(1_000);

        // stopGeneration posts the stop chunk either way — only the
        // closing assertion proves it found the successor to abort.
        appendCount = 0;
        expect(await transport.stopGeneration("chat-race")).toBe(true);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(appendCount).toBe(1);
        expect(secondClosed).toBe(true);

        transport.dispose();
        await secondDrain;
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the tab claim the successor took (multi-tab)", async () => {
      vi.useFakeTimers();
      try {
        global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
          // Open SSE that only ends when the subscription is aborted, so
          // the superseded stream tears down while the successor is live.
          if (isSessionOutSubscribeUrl(urlStr)) return openSseResponse(init?.signal);
          throw new Error(`Unexpected URL: ${urlStr}`);
        });

        const transport = new TriggerChatTransport({
          task: "my-chat-task",
          accessToken: () => "pat",
          multiTab: true,
          sessions: { "chat-race-tab": { publicAccessToken: "p", isStreaming: true } },
        });

        const send = () =>
          transport.sendMessages({
            trigger: "submit-message" as const,
            chatId: "chat-race-tab",
            messageId: undefined,
            messages: [createUserMessage("hi")],
            abortSignal: undefined,
          });

        const first = drainChunks(await send());
        await vi.advanceTimersByTimeAsync(1_000);
        const secondDrain = drainChunks(await send());
        await first;
        await vi.advanceTimersByTimeAsync(1_000);

        // The superseded stream must not release the claim its successor
        // holds — otherwise this tab flips to read-only mid-turn.
        expect(transport.hasClaim("chat-race-tab")).toBe(true);

        transport.dispose();
        await secondDrain;
      } finally {
        vi.useRealTimers();
      }
    });

    it("releases the tab claim when the user stops generation (multi-tab)", async () => {
      vi.useFakeTimers();
      try {
        global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
          if (isSessionOutSubscribeUrl(urlStr)) return openSseResponse(init?.signal);
          throw new Error(`Unexpected URL: ${urlStr}`);
        });

        const transport = new TriggerChatTransport({
          task: "my-chat-task",
          accessToken: () => "pat",
          multiTab: true,
          sessions: { "chat-stop-tab": { publicAccessToken: "p", isStreaming: true } },
        });

        const drain = drainChunks(
          await transport.sendMessages({
            trigger: "submit-message" as const,
            chatId: "chat-stop-tab",
            messageId: undefined,
            messages: [createUserMessage("hi")],
            abortSignal: undefined,
          })
        );
        await vi.advanceTimersByTimeAsync(1_000);
        expect(transport.hasClaim("chat-stop-tab")).toBe(true);

        expect(await transport.stopGeneration("chat-stop-tab")).toBe(true);
        await vi.advanceTimersByTimeAsync(1_000);

        // The turn ends here with no successor stream, so the claim must be
        // freed or other tabs stay read-only until this one closes.
        expect(transport.hasClaim("chat-stop-tab")).toBe(false);

        transport.dispose();
        await drain;
      } finally {
        vi.useRealTimers();
      }
    });

    it("releases the tab claim when the consumer aborts a turn that writes no stop (multi-tab)", async () => {
      // Catches: an abort that writes no stop deletes the stream's activeStreams
      // entry, so the stream's own unwinding no longer frees the tab claim and
      // other tabs stay read-only until this one closes.
      vi.useFakeTimers();
      try {
        global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
          const urlStr = typeof url === "string" ? url : url.toString();
          if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
          if (isSessionOutSubscribeUrl(urlStr)) return openSseResponse(init?.signal);
          throw new Error(`Unexpected URL: ${urlStr}`);
        });

        const transport = new TriggerChatTransport({
          task: "my-chat-task",
          accessToken: () => "pat",
          multiTab: true,
          sessions: { "chat-abort-tab": { publicAccessToken: "p", isStreaming: true } },
        });

        const abort = new AbortController();
        const drain = drainChunks(
          await transport.sendMessages({
            trigger: "submit-message" as const,
            chatId: "chat-abort-tab",
            messageId: undefined,
            messages: [createUserMessage("hi")],
            abortSignal: abort.signal,
          })
        );
        await vi.advanceTimersByTimeAsync(1_000);
        expect(transport.hasClaim("chat-abort-tab")).toBe(true);

        // The outstanding turn is abandoned, so the abort has no stop to write.
        transport.clearSupersedeGate("chat-abort-tab");
        abort.abort();
        // Checked synchronously: the abort listener's release is the only one
        // on this path, before anything has had a chance to unwind.
        expect(transport.hasClaim("chat-abort-tab")).toBe(false);

        await vi.advanceTimersByTimeAsync(1_000);
        expect(transport.hasClaim("chat-abort-tab")).toBe(false);

        transport.dispose();
        await drain;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("multi-tab coordination", () => {
    it("isReadOnly defaults to false when multiTab is disabled", () => {
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
      });
      expect(transport.isReadOnly("any-chat")).toBe(false);
      expect(transport.hasClaim("any-chat")).toBe(false);
    });
  });

  describe("endpoint (chat.handover routing)", () => {
    /**
     * Encode UIMessageChunks the same way the chat-server.ts handler
     * does: `data: <JSON>\n\n` per chunk. The transport's
     * `parseUIMessageSseTransform` parses this back into chunk objects.
     */
    function handoverSseBody(chunks: UIMessageChunk[]): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
          controller.close();
        },
      });
    }

    function handoverResponse(args: {
      chatId: string;
      accessToken: string;
      chunks: UIMessageChunk[];
      pendingVersion?: boolean;
    }): Response {
      return new Response(handoverSseBody(args.chunks), {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "X-Trigger-Chat-Id": args.chatId,
          "X-Trigger-Chat-Access-Token": args.accessToken,
          ...(args.pendingVersion ? { "X-Trigger-Chat-Pending-Version": "1" } : {}),
        },
      });
    }

    it("emits run-pending-version when the handover endpoint reports a parked run", async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr === "https://my-app.example/api/chat") {
          return handoverResponse({
            chatId: "chat-handover-parked",
            accessToken: "handover-pat-parked",
            chunks: sampleChunks,
            pendingVersion: true,
          });
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const events: ChatTransportEvent[] = [];
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        headStart: "https://my-app.example/api/chat",
        onEvent: (event) => events.push(event),
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-handover-parked",
        messageId: "m1",
        messages: [createUserMessage("hello")],
        abortSignal: undefined,
      });
      // Step 1 still arrives from the warm server.
      expect(await drainChunks(stream)).toEqual(sampleChunks);

      const parked = events.filter((e) => e.type === "run-pending-version");
      expect(parked).toHaveLength(1);
      expect(parked[0]).toMatchObject({ chatId: "chat-handover-parked", source: "head-start" });
    });

    it("first-turn POSTs the wire payload to endpoint when no session exists", async () => {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        requests.push({ url: urlStr, init });
        if (urlStr === "https://my-app.example/api/chat") {
          return handoverResponse({
            chatId: "chat-handover-1",
            accessToken: "handover-pat-1",
            chunks: sampleChunks,
          });
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        headStart: "https://my-app.example/api/chat",
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-handover-1",
        messageId: "m1",
        messages: [createUserMessage("hello")],
        abortSignal: undefined,
      });
      const chunks = await drainChunks(stream);

      // Chunks were forwarded from the handler's SSE body unchanged.
      expect(chunks).toEqual(sampleChunks);

      // Only the endpoint was called — no /api/v1/sessions, no .in/append,
      // no .out subscribe. The handler owns first-turn end-to-end.
      const endpointPosts = requests.filter((r) => r.url === "https://my-app.example/api/chat");
      expect(endpointPosts).toHaveLength(1);
      expect(requests.some((r) => isSessionCreateUrl(r.url))).toBe(false);
      expect(requests.some((r) => isSessionStreamAppendUrl(r.url))).toBe(false);
      expect(requests.some((r) => isSessionOutSubscribeUrl(r.url))).toBe(false);

      // Body shape: head-start wire payload. Full UIMessage history is
      // shipped via `headStartMessages` (this is the one path that still
      // ships full history — the route handler runs against the customer's
      // own HTTP endpoint, not /in/append, so the 512 KiB cap doesn't
      // apply). The `message` field is omitted on this path.
      const body = JSON.parse(endpointPosts[0]!.init!.body as string);
      expect(body.chatId).toBe("chat-handover-1");
      expect(body.trigger).toBe("submit-message");
      expect(body.messageId).toBe("m1");
      expect(body.headStartMessages).toHaveLength(1);
      expect(body.message).toBeUndefined();
      expect(body.messages).toBeUndefined();
    });

    it("hydrates session state from response headers so subsequent turns bypass the endpoint", async () => {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        requests.push({ url: urlStr, init });
        if (urlStr === "https://my-app.example/api/chat") {
          return handoverResponse({
            chatId: "chat-handover-2",
            accessToken: "handover-pat-2",
            chunks: sampleChunks,
          });
        }
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const onSessionChange = vi.fn();
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "fallback-pat",
        headStart: "https://my-app.example/api/chat",
        onSessionChange,
      });

      // Turn 1 — POSTs to endpoint, hydrates session.
      await drainChunks(
        await transport.sendMessages({
          trigger: "submit-message",
          chatId: "chat-handover-2",
          messageId: "m1",
          messages: [createUserMessage("first")],
          abortSignal: undefined,
        })
      );

      const hydrated = transport.getSession("chat-handover-2");
      expect(hydrated).toBeDefined();
      expect(hydrated!.publicAccessToken).toBe("handover-pat-2");
      expect(onSessionChange).toHaveBeenCalledWith(
        "chat-handover-2",
        expect.objectContaining({ publicAccessToken: "handover-pat-2" })
      );

      // Turn 2 — bypass endpoint, write directly to .in.
      requests.length = 0;
      const turn2Stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-handover-2",
        messageId: "m2",
        messages: [createUserMessage("second")],
        abortSignal: undefined,
      });

      expect(requests.some((r) => r.url === "https://my-app.example/api/chat")).toBe(false);

      const append = requests.find(
        (r) => isSessionStreamAppendUrl(r.url) && r.url.endsWith("/in/append")
      );
      expect(append).toBeDefined();
      expect(chatIdFromUrl(append!.url)).toBe("chat-handover-2");

      // Drain after asserting append — `.out` is subscribed lazily when the
      // returned stream is read.
      await drainChunks(turn2Stream);

      const subscribe = requests.find((r) => isSessionOutSubscribeUrl(r.url));
      expect(subscribe).toBeDefined();
    });

    it("bypasses endpoint when a session is already hydrated (page reload after first turn)", async () => {
      const requests: Array<{ url: string; init?: RequestInit }> = [];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        requests.push({ url: urlStr, init });
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        headStart: "https://my-app.example/api/chat",
        sessions: {
          "chat-resumed": { publicAccessToken: "persisted-pat" },
        },
      });

      await drainChunks(
        await transport.sendMessages({
          trigger: "submit-message",
          chatId: "chat-resumed",
          messageId: undefined,
          messages: [createUserMessage("hi again")],
          abortSignal: undefined,
        })
      );

      expect(requests.some((r) => r.url === "https://my-app.example/api/chat")).toBe(false);
      expect(requests.some((r) => isSessionStreamAppendUrl(r.url))).toBe(true);
    });

    it("propagates a non-2xx response from the endpoint as an error", async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr === "https://my-app.example/api/chat") {
          return new Response(null, { status: 500, statusText: "Internal Server Error" });
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        headStart: "https://my-app.example/api/chat",
      });

      await expect(
        transport.sendMessages({
          trigger: "submit-message",
          chatId: "chat-handover-err",
          messageId: undefined,
          messages: [createUserMessage("oops")],
          abortSignal: undefined,
        })
      ).rejects.toThrow(/500/);
    });

    it("leaves the legacy direct-trigger path unchanged when endpoint is unset", async () => {
      const requests: string[] = [];
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        requests.push(urlStr);
        if (isSessionStreamAppendUrl(urlStr)) return defaultAppendResponse();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse();
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        // endpoint NOT set
        sessions: { "chat-legacy": { publicAccessToken: "p" } },
      });

      await drainChunks(
        await transport.sendMessages({
          trigger: "submit-message",
          chatId: "chat-legacy",
          messageId: undefined,
          messages: [createUserMessage("legacy")],
          abortSignal: undefined,
        })
      );

      // No POST to /api/chat anywhere.
      expect(requests.some((u) => u.endsWith("/api/chat"))).toBe(false);
      expect(requests.some(isSessionStreamAppendUrl)).toBe(true);
      expect(requests.some(isSessionOutSubscribeUrl)).toBe(true);
    });
  });

  describe("watch mode", () => {
    it("keeps the SSE open across trigger:turn-complete (multi-turn watch)", async () => {
      const turn1: (UIMessageChunk | Record<string, unknown>)[] = [
        { type: "text-delta", id: "p1", delta: "Hi" },
        { type: "trigger:turn-complete" },
        { type: "text-delta", id: "p2", delta: "Again" },
        { type: "trigger:turn-complete" },
      ];
      let subscribeCount = 0;
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionOutSubscribeUrl(urlStr)) {
          subscribeCount++;
          if (subscribeCount === 1) return defaultSseResponse(turn1);
          // Watch mode reconnects past the body EOF; settle so the drain ends.
          const response = defaultSseResponse([]);
          const headers = new Headers(response.headers);
          headers.set("X-Session-Settled", "true");
          return new Response(response.body, { status: 200, headers });
        }
        throw new Error(`Unexpected URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => "pat",
        watch: true,
        sessions: {
          "chat-watch": { publicAccessToken: "p", isStreaming: true },
        },
      });

      const stream = await transport.reconnectToStream({ chatId: "chat-watch" });
      const surfaced = await drainChunks(stream!);

      // Both trigger:turn-complete control chunks filtered; both
      // text-deltas surfaced because watch mode kept the loop alive
      // through the first turn-complete.
      const textChunks = surfaced.filter((c: any) => c.type === "text-delta");
      expect(textChunks).toHaveLength(2);
    });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A reload or reconnect without a `.out` cursor must not replay earlier turns
// ───────────────────────────────────────────────────────────────────────────

describe("TriggerChatTransport without a .out cursor", () => {
  type LogRecord = {
    seq: number;
    chunk?: unknown;
    boundary?: boolean;
    inCursor?: number;
    /** A `turn-start` marker naming the `.in` seq its turn answers. */
    turnStartFor?: number;
  };
  type RecordsMode = "headers" | "no-headers" | "fail";

  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  /** One answered turn: a text part, then the boundary carrying the turn's `.in` cursor. */
  function answer(firstSeq: number, text: string, inCursor: number | undefined): LogRecord[] {
    return [
      { seq: firstSeq, chunk: { type: "text-start", id: `t-${firstSeq}` } },
      { seq: firstSeq + 1, chunk: { type: "text-delta", id: `t-${firstSeq}`, delta: text } },
      { seq: firstSeq + 2, chunk: { type: "text-end", id: `t-${firstSeq}` } },
      { seq: firstSeq + 3, boundary: true, inCursor },
    ];
  }

  const texts = (chunks: UIMessageChunk[]) =>
    chunks
      .filter((c): c is Extract<UIMessageChunk, { type: "text-delta" }> => c.type === "text-delta")
      .map((c) => c.delta);

  const earlierTurns = [...answer(1, "answer one", 1), ...answer(5, "answer two", 2)];

  const boundaryHeaders = (r: LogRecord) => [
    ["trigger-control", "turn-complete"],
    ...(r.inCursor !== undefined ? [["session-in-event-id", String(r.inCursor)]] : []),
  ];
  const isControl = (r: LogRecord) => r.boundary === true || r.turnStartFor !== undefined;
  const controlHeaders = (r: LogRecord) =>
    r.turnStartFor !== undefined
      ? [
          ["trigger-control", "turn-start"],
          ["turn-start-in-seq", String(r.turnStartFor)],
        ]
      : boundaryHeaders(r);

  /**
   * A session that keeps `.in` and `.out` the way the server does: an append
   * gets the next `.in` seq and `onAppend` plays the agent onto `.out`; the
   * `wait=0` records drain and the SSE read both serve the records after their
   * cursor (the whole retained window when they send none).
   */
  function stubSession(options: {
    retained: LogRecord[];
    inSeq: number;
    records?: RecordsMode;
    /** `.out/records` waits for this, and rejects as a real fetch does when its signal aborts. */
    recordsGate?: Promise<void>;
    /** The nth `.out/records` request waits for this (a read-back after the lookup). */
    holdRecordsCall?: { nth: number; until: Promise<void> };
    onAppend?: (inSeq: number, log: LogRecord[]) => void;
  }) {
    const log = [...options.retained];
    let inSeq = options.inSeq;
    const recordsMode = options.records ?? "headers";
    const outReads: Array<string | null> = [];
    const appendBodies: string[] = [];
    let recordsCalls = 0;

    const sse = (records: LogRecord[]) =>
      new Response(
        records.length
          ? `event: batch\ndata: ${JSON.stringify({
              records: records.map((r) => ({
                body: isControl(r) ? "" : JSON.stringify({ data: r.chunk, id: `p-${r.seq}` }),
                seq_num: r.seq,
                timestamp: r.seq,
                headers: isControl(r) ? controlHeaders(r) : [],
              })),
            })}\n\n`
          : "",
        {
          status: 200,
          headers: { "content-type": "text/event-stream", "X-Stream-Version": "v2" },
        }
      );

    global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("/out/records")) {
        recordsCalls++;
        const signal = init?.signal ?? undefined;
        if (options.recordsGate) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => reject(new DOMException("aborted", "AbortError"));
            if (signal?.aborted) return abort();
            signal?.addEventListener("abort", abort, { once: true });
            options.recordsGate!.then(resolve, reject);
          });
        }
        if (options.holdRecordsCall?.nth === recordsCalls) await options.holdRecordsCall.until;
        if (recordsMode === "fail") return new Response("nope", { status: 404 });
        const after = Number(new URL(urlStr).searchParams.get("afterEventId") ?? 0);
        return Response.json({
          records: log
            .filter((r) => r.seq > after)
            .map((r) => ({
              data: isControl(r) ? "" : r.chunk,
              id: String(r.seq),
              seqNum: r.seq,
              ...(isControl(r) && recordsMode === "headers" ? { headers: controlHeaders(r) } : {}),
            })),
        });
      }
      if (isSessionStreamAppendUrl(urlStr)) {
        const body = String(init?.body ?? "");
        appendBodies.push(body);
        // A stop is an ordinary `.in` record: it takes the next seq, and the agent
        // answers nothing for it.
        inSeq += 1;
        if (!/"kind":"stop"/.test(body)) options.onAppend?.(inSeq, log);
        return new Response(JSON.stringify({ ok: true, seq: inSeq }), { status: 200 });
      }
      if (isSessionOutSubscribeUrl(urlStr)) {
        const lastEventId = new Headers(init?.headers).get("Last-Event-ID");
        outReads.push(lastEventId);
        const after = lastEventId ? Number(lastEventId) : 0;
        return sse(log.filter((r) => r.seq > after));
      }
      throw new Error(`Unexpected URL: ${urlStr}`);
    });

    return { log, outReads, appendBodies, recordsCalls: () => recordsCalls };
  }

  // The agent answers each message as soon as it lands on `.in`.
  const answerEach = (inSeq: number, log: LogRecord[]) => {
    log.push(...answer((log.at(-1)?.seq ?? 0) + 1, `answer ${inSeq}`, inSeq));
  };

  function makeTransport(session: ChatSessionPersistedState = { publicAccessToken: "p" }) {
    return new TriggerChatTransport({
      task: "my-chat-task",
      accessToken: () => "pat",
      sessions: { "chat-x": session },
    });
  }

  const send = (transport: TriggerChatTransport, abortSignal?: AbortSignal) =>
    transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-x",
      messageId: undefined,
      messages: [createUserMessage("three")],
      abortSignal,
    });

  // `headers` finds where the turn starts and streams live from there; the others
  // can't, and hold the chunks until a boundary says whose they are.
  for (const records of ["headers", "no-headers", "fail"] as const) {
    it(`sendMessages surfaces only the new turn when the window holds earlier turns (${records})`, async () => {
      // Catches: a reload with no `.out` cursor re-streaming the previous turn's
      // chunks to the UI ahead of the new answer (the browser transport only skipped
      // the earlier turn's turn-complete, not its chunks).
      const session = stubSession({
        retained: earlierTurns,
        inSeq: 2,
        records,
        onAppend: answerEach,
      });

      const stream = await send(makeTransport());
      const chunks = await drainChunks(stream);

      expect(texts(chunks)).toEqual(["answer 3"]);
      if (records === "headers") {
        // Streamed live from the last earlier boundary, not from the window start.
        expect(session.outReads).toEqual(["8"]);
      }
    });
  }

  it("sendAction surfaces only the action's own turn when the window holds earlier turns", async () => {
    // Catches: the same replay on the action path, which opens its stream the same way.
    stubSession({ retained: earlierTurns, inSeq: 2, onAppend: answerEach });

    const stream = await makeTransport().sendAction("chat-x", { type: "undo" });

    expect(texts(await drainChunks(stream))).toEqual(["answer 3"]);
  });

  it("persists the located turn start so a reload mid-turn resumes from it", async () => {
    // Catches: a cursorless send persisting no cursor for its turn, so every
    // reload before the turn completes starts from the window start again.
    const session = stubSession({ retained: earlierTurns, inSeq: 2, onAppend: answerEach });
    const transport = makeTransport();

    const stream = await send(transport);

    expect(transport.getSession("chat-x")?.lastEventId).toBe("8");
    await drainChunks(stream);
    expect(session.outReads).toEqual(["8"]);
  });

  for (const records of ["headers", "fail"] as const) {
    it(`reconnectToStream resumes the turn in flight without replaying the previous answer (${records})`, async () => {
      // Catches: a reload mid-answer with no persisted `.out` cursor re-streaming
      // the previous turn's chunks before the turn it is resuming.
      stubSession({
        retained: [...earlierTurns, ...answer(9, "answer 3", 3)],
        inSeq: 3,
        records,
      });
      const transport = makeTransport({
        publicAccessToken: "p",
        isStreaming: true,
        activeInputSeq: 3,
      });

      const stream = await transport.reconnectToStream({ chatId: "chat-x" });

      expect(texts(await drainChunks(stream!))).toEqual(["answer 3"]);
    });
  }

  it("holds the answer when an earlier message is queued and nothing of its turn is on .out yet", async () => {
    // Catches: the lookup ending its hold at a quiet tail whose last boundary's
    // cursor is below this send's predecessor (message 2 is queued, unanswered),
    // so message 2's reply streamed as this send's: ["answer 2", "answer 3"].
    stubSession({
      retained: [...answer(1, "answer one", 1)],
      inSeq: 2,
      // The agent has not started message 2's turn when the lookup reads `.out`,
      // and answers 2 then 3 shortly after.
      onAppend: (inSeq, log) => {
        setTimeout(() => {
          log.push(...answer((log.at(-1)?.seq ?? 0) + 1, "answer 2", 2));
          log.push(...answer((log.at(-1)?.seq ?? 0) + 1, `answer ${inSeq}`, inSeq));
        }, 50);
      },
    });

    const stream = await send(makeTransport());

    expect(texts(await drainChunks(stream))).toEqual(["answer 3"]);
  });

  it("resumes a turn a recovery ended with an error, whose boundary cursor still sits behind", async () => {
    // Catches: a cursorless reconnect treating the recovered turn's own boundary
    // as an earlier turn's because its committed `.in` cursor is behind (the
    // router holds it below owed inputs), skipping the turn's error and
    // completion and waiting for an answer the agent had already ended.
    stubSession({
      retained: [
        ...answer(1, "answer one", 1),
        { seq: 5, turnStartFor: 2 },
        { seq: 6, chunk: { type: "error", errorText: "recovered" } },
        { seq: 7, boundary: true, inCursor: 1 },
      ],
      inSeq: 2,
    });
    const transport = makeTransport({
      publicAccessToken: "p",
      isStreaming: true,
      activeInputSeq: 2,
    });

    const stream = await transport.reconnectToStream({ chatId: "chat-x" });
    const reader = stream!.getReader();
    const seen: string[] = [];
    let ended = false;
    const deadline = Date.now() + 1_500;
    // One read stays pending across iterations: abandoning it on the idle timer
    // would let it consume the chunk the next read was waiting for.
    let pending: ReturnType<typeof reader.read> | undefined;
    while (Date.now() < deadline && !ended) {
      pending ??= reader.read();
      const next = await Promise.race([
        pending,
        new Promise<"idle">((resolve) => setTimeout(() => resolve("idle"), 200)),
      ]);
      if (next === "idle") continue;
      pending = undefined;
      if (next.done) ended = true;
      else seen.push(next.value.type);
    }
    await reader.cancel().catch(() => {});

    expect(seen).toEqual(["error"]);
    expect(ended).toBe(true);
  });

  it("leaves the replacement send's state alone when a send is superseded during the read-back of a dropped turn", async () => {
    // Catches: the old reader, once its read-back of a turn it had dropped as
    // another's resolved (the abort is absorbed), delivering the chunks and
    // clearing the new send's `activeInputSeq` and `isStreaming`.
    let release!: () => void;
    const until = new Promise<void>((resolve) => (release = resolve));
    const session = stubSession({
      // A turn the marker names for message 1 closes past message 2, so it
      // answered message 2 after all and is read back at its boundary.
      retained: [
        { seq: 1, turnStartFor: 1 },
        { seq: 2, chunk: { type: "text-delta", id: "t-2", delta: "dropped" } },
        { seq: 3, boundary: true, inCursor: 2 },
      ],
      inSeq: 1,
      holdRecordsCall: { nth: 2, until },
    });
    const transport = makeTransport();

    const first = await send(transport);
    const firstChunks = drainChunks(first);
    await vi.waitFor(() => expect(session.recordsCalls()).toBe(2));
    const second = await send(transport);
    release();

    expect(await firstChunks).toEqual([]);
    expect(transport.getSession("chat-x")).toMatchObject({ isStreaming: true, activeInputSeq: 3 });
    await second.cancel();
  });

  for (const stoppedBy of ["stopGeneration", "aborting the send's own signal"] as const) {
    it(`answers the next send after ${stoppedBy} during the read-back of a dropped turn`, async () => {
      // Catches: a stop landing while the read-back of a turn the stream already
      // read the boundary of is pending arming the stop gate for a boundary that has
      // gone by. The next send has a saved cursor past it, so the gate swallowed its
      // output and failed it with "The previous turn's output was lost".
      let release!: () => void;
      const until = new Promise<void>((resolve) => (release = resolve));
      const session = stubSession({
        retained: [
          { seq: 1, turnStartFor: 1 },
          { seq: 2, chunk: { type: "text-delta", id: "t-2", delta: "dropped" } },
          { seq: 3, boundary: true, inCursor: 2 },
        ],
        inSeq: 1,
        holdRecordsCall: { nth: 2, until },
        // Only the replacement's message is answered (the stop takes seq 3).
        onAppend: (inSeq, log) => {
          if (inSeq > 2) answerEach(inSeq, log);
        },
      });
      const transport = makeTransport();
      const abort = new AbortController();

      const first = await send(transport, abort.signal);
      const firstChunks = drainChunks(first);
      await vi.waitFor(() => expect(session.recordsCalls()).toBe(2));
      if (stoppedBy === "stopGeneration")
        expect(await transport.stopGeneration("chat-x")).toBe(true);
      else abort.abort();
      release();
      await firstChunks;

      expect(transport.getSession("chat-x")).toMatchObject({ isStreaming: false });
      const second = await send(transport);
      expect(texts(await drainChunks(second))).toEqual(["answer 4"]);
      expect(transport.getSession("chat-x")).toMatchObject({
        isStreaming: false,
        activeInputSeq: undefined,
      });
    });
  }

  for (const stoppedBy of ["stopGeneration", "aborting the send's own signal"] as const) {
    it(`answers a send that starts while the read-back is still pending after ${stoppedBy}`, async () => {
      // Catches: the saved cursor already sitting past the stopped turn's boundary
      // while its read-back is pending, so the stop gate waited for a boundary the
      // reader had passed and a send started in that window dropped its whole answer
      // ("The previous turn's output was lost").
      let release!: () => void;
      const until = new Promise<void>((resolve) => (release = resolve));
      const session = stubSession({
        retained: [
          { seq: 1, turnStartFor: 1 },
          { seq: 2, chunk: { type: "text-delta", id: "t-2", delta: "dropped" } },
          { seq: 3, boundary: true, inCursor: 2 },
        ],
        inSeq: 1,
        holdRecordsCall: { nth: 2, until },
        onAppend: (inSeq, log) => {
          if (inSeq > 2) answerEach(inSeq, log);
        },
      });
      const transport = makeTransport();
      const abort = new AbortController();

      const first = await send(transport, abort.signal);
      const firstChunks = drainChunks(first);
      await vi.waitFor(() => expect(session.recordsCalls()).toBe(2));
      if (stoppedBy === "stopGeneration")
        expect(await transport.stopGeneration("chat-x")).toBe(true);
      else abort.abort();
      // The replacement starts and is read before the old read-back returns.
      const second = await send(transport);
      const secondChunks = drainChunks(second);
      // Its own `.out` read, after the first stream's, is under way.
      await vi.waitFor(() => expect(session.outReads.length).toBeGreaterThanOrEqual(2));
      release();
      await firstChunks;

      expect(texts(await secondChunks)).toEqual(["answer 4"]);
      expect(transport.getSession("chat-x")).toMatchObject({
        isStreaming: false,
        activeInputSeq: undefined,
      });
    });
  }

  for (const stoppedBy of ["stopGeneration", "aborting the send's own signal"] as const) {
    it(`answers the retry after ${stoppedBy} during a read-back, with older completions in the window`, async () => {
      // Catches: the read-back restoring the saved cursor to the one the holding
      // lookup kept in memory only (undefined), so the retry (a Stop bypasses the
      // lookup) read from the start of the window and an older cursorless completion
      // cleared the gate and settled it with no answer.
      let release!: () => void;
      const until = new Promise<void>((resolve) => (release = resolve));
      const session = stubSession({
        retained: [
          // Completions of older turns: one from an agent that writes no cursor
          // (or a handover first turn), one at `.in` cursor 0.
          { seq: 1, boundary: true },
          { seq: 2, boundary: true, inCursor: 0 },
          // The marked turn for input 1 closes past input 2, so it answered it.
          { seq: 3, turnStartFor: 1 },
          { seq: 4, chunk: { type: "text-delta", id: "t-4", delta: "dropped" } },
          { seq: 5, boundary: true, inCursor: 2 },
        ],
        inSeq: 1,
        holdRecordsCall: { nth: 2, until },
        // Only the retry's message is answered (the stop takes seq 3).
        onAppend: (inSeq, log) => {
          if (inSeq > 2) answerEach(inSeq, log);
        },
      });
      const transport = makeTransport();
      const abort = new AbortController();

      const first = await send(transport, abort.signal);
      const firstChunks = drainChunks(first);
      await vi.waitFor(() => expect(session.recordsCalls()).toBe(2));
      if (stoppedBy === "stopGeneration")
        expect(await transport.stopGeneration("chat-x")).toBe(true);
      else abort.abort();
      release();
      await firstChunks;

      const retry = await send(transport);
      expect(texts(await drainChunks(retry))).toEqual(["answer 4"]);
    });
  }

  describe("while a dropped turn's read-back is pending", () => {
    // An earlier turn, then a turn the marker names for message 1 that closes past
    // message 2: it answered message 2 after all, and is read back at its boundary.
    const retained = [
      ...answer(1, "answer one", 0),
      { seq: 5, turnStartFor: 1 },
      { seq: 6, chunk: { type: "text-delta", id: "t-6", delta: "dropped" } },
      { seq: 7, boundary: true, inCursor: 2 },
    ] satisfies LogRecord[];

    function pendingReadBack() {
      let release!: () => void;
      const until = new Promise<void>((resolve) => (release = resolve));
      const session = stubSession({ retained, inSeq: 1, holdRecordsCall: { nth: 2, until } });
      return { session, release };
    }

    it("refuses a reconnect, and the send still finishes with its own answer", async () => {
      // Catches: a reconnect opening a second reader on a turn whose boundary the
      // send's stream has already read, or the send losing its answer to it.
      const { session, release } = pendingReadBack();
      const transport = makeTransport();

      const sent = await send(transport);
      const sentChunks = drainChunks(sent);
      await vi.waitFor(() => expect(session.recordsCalls()).toBe(2));

      expect(await transport.reconnectToStream({ chatId: "chat-x" })).toBeNull();
      release();

      expect(texts(await sentChunks)).toEqual(["dropped"]);
      expect(transport.getSession("chat-x")).toMatchObject({ isStreaming: false });
    });

    it("resumes the turn's answer once after a reload, without the earlier turn's output", async () => {
      // Catches: a reload at this moment, from the session saved then (no cursor
      // yet, the turn's seq), replaying the earlier turn or losing the answer.
      const { session, release } = pendingReadBack();
      const transport = makeTransport();

      const sent = await send(transport);
      const sentChunks = drainChunks(sent);
      await vi.waitFor(() => expect(session.recordsCalls()).toBe(2));
      const saved = transport.getSession("chat-x")!;
      expect(saved).toMatchObject({ isStreaming: true, activeInputSeq: 2 });

      const resumed = await makeTransport(saved).reconnectToStream({ chatId: "chat-x" });

      expect(texts(await drainChunks(resumed!))).toEqual(["dropped"]);
      release();
      await sentChunks;
    });
  });

  it("keeps a resume's turn seq when its consumer aborts without a stop during a dropped turn's read-back", async () => {
    // Catches: clearing the turn's `activeInputSeq` for any reader aborted during
    // the read-back, including a resume whose consumer unmounted and wrote no stop.
    // The turn stays streaming with no cursor and no seq, so the next resume made
    // no lookup and read from the window start: "answer one" came back as this turn's.
    let release!: () => void;
    const until = new Promise<void>((resolve) => (release = resolve));
    const session = stubSession({
      retained: [
        ...answer(1, "answer one", 0),
        { seq: 5, turnStartFor: 1 },
        { seq: 6, chunk: { type: "text-delta", id: "t-6", delta: "dropped" } },
        { seq: 7, boundary: true, inCursor: 2 },
      ],
      inSeq: 1,
      holdRecordsCall: { nth: 2, until },
    });
    const transport = makeTransport({
      publicAccessToken: "p",
      isStreaming: true,
      activeInputSeq: 2,
    });
    const abort = new AbortController();

    const first = await transport.reconnectToStream({
      chatId: "chat-x",
      abortSignal: abort.signal,
    });
    const firstChunks = drainChunks(first!);
    await vi.waitFor(() => expect(session.recordsCalls()).toBe(2));
    abort.abort();
    release();
    await firstChunks;

    expect(transport.getSession("chat-x")).toMatchObject({ isStreaming: true, activeInputSeq: 2 });
    const second = await transport.reconnectToStream({ chatId: "chat-x" });
    expect(texts(await drainChunks(second!))).toEqual(["dropped"]);
    // It repeated the lookup rather than reading from the window start.
    expect(session.recordsCalls()).toBeGreaterThanOrEqual(3);
  });

  it("keeps the previous behaviour for an agent that writes no cursor on its boundaries", async () => {
    // Catches: the lookup hanging, or dropping the turn, for an agent that predates
    // the `.in` cursor header; it must still end the stream on a boundary as it did.
    stubSession({
      retained: [...answer(1, "answer one", undefined)],
      inSeq: 1,
      onAppend: (inSeq, log) =>
        log.push(...answer((log.at(-1)?.seq ?? 0) + 1, `answer ${inSeq}`, undefined)),
    });

    const stream = await send(makeTransport());

    expect(texts(await drainChunks(stream))).toEqual(["answer 2"]);
  });

  it("does not persist a cursor past chunks it holds when the turn is cancelled", async () => {
    // Catches: held chunks advancing the cursor, so after a cancel the persisted
    // cursor sits past the first undelivered chunk and a reload loses the turn's start.
    const session = stubSession({
      // The own turn's first chunks are on `.out` but its boundary is not yet.
      retained: [
        ...earlierTurns,
        { seq: 9, chunk: { type: "text-start", id: "t-9" } },
        { seq: 10, chunk: { type: "text-delta", id: "t-9", delta: "partial" } },
      ],
      inSeq: 2,
      records: "fail",
    });
    const transport = makeTransport();
    const abort = new AbortController();

    const stream = await send(transport, abort.signal);
    const drained = drainChunks(stream);
    // The EOF resubscribe reads on from what it has read, not from the window start.
    await vi.waitFor(() => expect(session.outReads.length).toBeGreaterThanOrEqual(2), {
      timeout: 5_000,
    });
    abort.abort();
    expect(await drained).toEqual([]);

    // Once the cancelled turn no longer counts as streaming, the persisted cursor is
    // the session's own: the earlier turn's boundary (seq 8), not the held chunks (10).
    await vi.waitFor(() => expect(transport.getSession("chat-x")?.isStreaming).toBe(false));
    expect(transport.getSession("chat-x")?.lastEventId).toBe("8");
  });

  it("stops the lookup and posts the stop once when the caller aborts the send", async () => {
    // Catches: an aborted cursorless send waiting out the lookup, then streaming a
    // turn the caller already cancelled without ever stopping it; and the stopped
    // send leaving the saved session streaming, so a reload reopens the stopped reply.
    let release!: () => void;
    const recordsGate = new Promise<void>((resolve) => (release = resolve));
    const session = stubSession({
      retained: earlierTurns,
      inSeq: 2,
      recordsGate,
      onAppend: answerEach,
    });
    const abort = new AbortController();
    const transport = makeTransport();

    const sending = send(transport, abort.signal);
    await vi.waitFor(() => expect(session.recordsCalls()).toBe(1));
    abort.abort();
    const stream = await sending;
    await drainChunks(stream);
    release();

    const stops = session.appendBodies.filter((body) => /"kind":"stop"/.test(body));
    expect(stops).toHaveLength(1);
    expect(transport.getSession("chat-x")?.isStreaming).toBe(false);
  });

  it("reads .out/records through the fetch override with the session token and headers", async () => {
    // Catches: the lookup using the global fetch, which ignores the transport's
    // override, token and headers (a proxy or a custom auth scheme never sees it)
    // while every other test still passes by falling back to holding the chunks.
    stubSession({ retained: earlierTurns, inSeq: 2, onAppend: answerEach });
    const stubbed = global.fetch;
    const overridden: Array<{ url: string; init: RequestInit; endpoint: string }> = [];
    const transport = new TriggerChatTransport({
      task: "my-chat-task",
      accessToken: () => "pat",
      headers: { "X-Tenant": "acme" },
      fetch: async (url, init, ctx) => {
        overridden.push({ url, init, endpoint: ctx.endpoint });
        return stubbed(url, init);
      },
      sessions: { "chat-x": { publicAccessToken: "session-pat" } },
    });

    await drainChunks(await send(transport));

    const records = overridden.filter((call) => call.url.includes("/out/records"));
    expect(records.length).toBeGreaterThanOrEqual(1);
    const headers = new Headers(records[0]!.init.headers);
    expect(records[0]!.endpoint).toBe("out");
    expect(headers.get("Authorization")).toBe("Bearer session-pat");
    expect(headers.get("X-Tenant")).toBe("acme");
  });

  it("reconnectToStream gives way to a send that lands while its lookup is pending", async () => {
    // Catches: a reconnect whose lookup was overtaken by a send subscribing anyway,
    // leaving two readers on `.out` writing the same cursor.
    let release!: () => void;
    const recordsGate = new Promise<void>((resolve) => (release = resolve));
    const session = stubSession({
      retained: earlierTurns,
      inSeq: 2,
      recordsGate,
      onAppend: answerEach,
    });
    const transport = makeTransport({
      publicAccessToken: "p",
      isStreaming: true,
      activeInputSeq: 2,
    });

    const reconnecting = transport.reconnectToStream({ chatId: "chat-x" });
    await vi.waitFor(() => expect(session.recordsCalls()).toBe(1));
    const sending = send(transport);
    await vi.waitFor(() => expect(session.recordsCalls()).toBe(2));
    release();

    expect(await reconnecting).toBeNull();
    expect(texts(await drainChunks(await sending))).toEqual(["answer 3"]);
    expect(session.outReads).toHaveLength(1);
  });

  for (const via of ["sendMessages", "sendAction"] as const) {
    it(`stopGeneration while ${via} is locating its turn stops it cleanly`, async () => {
      // Catches: the send unregistering the active stream before its lookup, so a
      // stop in that window finds nothing to abort, the stream then subscribes and
      // the stop gate swallows the turn ("The previous turn's output was lost").
      let release!: () => void;
      const recordsGate = new Promise<void>((resolve) => (release = resolve));
      const session = stubSession({
        retained: earlierTurns,
        inSeq: 2,
        recordsGate,
        onAppend: answerEach,
      });
      const transport = makeTransport();

      const sending =
        via === "sendMessages" ? send(transport) : transport.sendAction("chat-x", { type: "undo" });
      await vi.waitFor(() => expect(session.recordsCalls()).toBe(1));
      expect(await transport.stopGeneration("chat-x")).toBe(true);
      release();

      expect(await drainChunks(await sending)).toEqual([]);
      const stops = session.appendBodies.filter((body) => /"kind":"stop"/.test(body));
      expect(stops).toHaveLength(1);
      expect(transport.getSession("chat-x")?.isStreaming).toBe(false);
    });
  }

  for (const second of ["sendMessages", "sendAction"] as const) {
    it(`a ${second} over a send still locating its turn keeps its own registration and stop`, async () => {
      // Catches: the superseded first send, once its lookup is aborted, still
      // subscribing: it overwrote the new send's registration and its teardown then
      // deleted it and dropped the tab claim, so a stop in the new send's lookup found
      // nothing to abort, the stop gate swallowed the turn, and a reconnect opened a
      // second reader.
      let release!: () => void;
      const recordsGate = new Promise<void>((resolve) => (release = resolve));
      const session = stubSession({
        retained: earlierTurns,
        inSeq: 2,
        recordsGate,
        onAppend: answerEach,
      });
      const transport = makeTransport();
      const first = send(transport);
      await vi.waitFor(() => expect(session.recordsCalls()).toBe(1));
      const next =
        second === "sendMessages"
          ? send(transport)
          : transport.sendAction("chat-x", { type: "undo" });
      await vi.waitFor(() => expect(session.recordsCalls()).toBe(2));

      // The first send ends empty, as the superseded stream does, and leaves the
      // new send's registration alone.
      expect(await drainChunks(await first)).toEqual([]);
      // A reconnect still finds the new send's stream, so no second reader opens.
      expect(await transport.reconnectToStream({ chatId: "chat-x" })).toBeNull();

      expect(await transport.stopGeneration("chat-x")).toBe(true);
      release();

      expect(await drainChunks(await next)).toEqual([]);
      const stops = session.appendBodies.filter((body) => /"kind":"stop"/.test(body));
      expect(stops).toHaveLength(1);
      expect(transport.getSession("chat-x")?.isStreaming).toBe(false);
    });
  }

  it("reconnectToStream does not open a second reader while a send is locating its turn", async () => {
    // Catches: a reload-style reconnect in the send's lookup window seeing no active
    // stream and subscribing alongside the send.
    let release!: () => void;
    const recordsGate = new Promise<void>((resolve) => (release = resolve));
    const session = stubSession({
      retained: earlierTurns,
      inSeq: 2,
      recordsGate,
      onAppend: answerEach,
    });
    const transport = makeTransport();

    const sending = send(transport);
    await vi.waitFor(() => expect(session.recordsCalls()).toBe(1));
    expect(await transport.reconnectToStream({ chatId: "chat-x" })).toBeNull();
    release();

    expect(texts(await drainChunks(await sending))).toEqual(["answer 3"]);
    expect(session.outReads).toHaveLength(1);
    expect(session.recordsCalls()).toBe(1);
  });
});
