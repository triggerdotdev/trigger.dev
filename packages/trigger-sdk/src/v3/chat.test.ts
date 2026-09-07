import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UIMessage, UIMessageChunk } from "ai";
import { TriggerChatTransport, createChatTransport, type ChatTransportEvent } from "./chat.js";

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
      return {
        body: "",
        seq_num: nextSeq++,
        timestamp: 1700000000000 + i,
        headers,
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
    }): Response {
      return new Response(handoverSseBody(args.chunks), {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "X-Trigger-Chat-Id": args.chatId,
          "X-Trigger-Chat-Access-Token": args.accessToken,
        },
      });
    }

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
