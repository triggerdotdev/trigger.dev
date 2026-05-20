import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UIMessage, UIMessageChunk } from "ai";
import { TriggerChatTransport, createChatTransport } from "./chat.js";

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

const DEFAULT_RUN_ID = "run_default";
const DEFAULT_SESSION_ID = "session_default";
const DEFAULT_SESSION_PAT = "pat_session_default";

function createSessionResponseBody(options?: {
  sessionId?: string;
  externalId?: string;
  publicAccessToken?: string;
  runId?: string;
}): string {
  const externalId = options?.externalId ?? null;
  return JSON.stringify({
    id: options?.sessionId ?? DEFAULT_SESSION_ID,
    externalId,
    type: "chat.agent",
    taskIdentifier: "my-chat-task",
    triggerConfig: { basePayload: { chatId: externalId ?? "" } },
    currentRunId: options?.runId ?? DEFAULT_RUN_ID,
    runId: options?.runId ?? DEFAULT_RUN_ID,
    publicAccessToken: options?.publicAccessToken ?? DEFAULT_SESSION_PAT,
    tags: [],
    metadata: null,
    closedAt: null,
    closedReason: null,
    expiresAt: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    isCached: false,
  });
}

function defaultSessionCreateResponse(options?: {
  sessionId?: string;
  externalId?: string;
  publicAccessToken?: string;
  runId?: string;
}): Response {
  return new Response(createSessionResponseBody(options), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

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

function authError(status = 401): Response {
  return new Response(
    JSON.stringify({ error: "Unauthorized", name: "TriggerApiError", status }),
    {
      status,
      headers: { "content-type": "application/json" },
    }
  );
}

/**
 * Drains a UIMessageChunk stream into an array. Used to assert what
 * the transport surfaced after filtering control chunks.
 */
async function drainChunks(
  stream: ReadableStream<UIMessageChunk>
): Promise<UIMessageChunk[]> {
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
            isStreaming: false,
          },
        },
      });

      const session = transport.getSession("chat-1");
      expect(session).toEqual({
        publicAccessToken: "hydrated-pat",
        lastEventId: "42",
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
      });

      expect(transport.getSession("chat-x")).toMatchObject({
        publicAccessToken: "tok",
        lastEventId: "10",
      });
      expect(onSessionChange).toHaveBeenCalledWith(
        "chat-x",
        expect.objectContaining({ publicAccessToken: "tok", lastEventId: "10" })
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
      const startSession = vi
        .fn()
        .mockResolvedValue({ publicAccessToken: "session-pat-2" });

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
      const startSession = vi
        .fn()
        .mockResolvedValue({ publicAccessToken: "session-pat-pre" });

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
      const startSession = vi
        .fn()
        .mockResolvedValue({ publicAccessToken: "session-pat-cd" });

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
      const startSession = vi
        .fn()
        .mockResolvedValue({ publicAccessToken: "session-pat-set" });

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
      const startSession = vi
        .fn()
        .mockResolvedValue({ publicAccessToken: "lazy-session-pat" });

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

      const append = requests.find((r) =>
        isSessionStreamAppendUrl(r.url) && r.url.endsWith("/in/append")
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
      const endpointPosts = requests.filter(
        (r) => r.url === "https://my-app.example/api/chat"
      );
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
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (isSessionOutSubscribeUrl(urlStr)) return defaultSseResponse(turn1);
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
