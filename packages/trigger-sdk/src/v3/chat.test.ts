import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UIMessage, UIMessageChunk } from "ai";
import { TriggerChatTransport, createChatTransport } from "./chat.js";

// Helper: encode text as SSE format
function sseEncode(chunks: (UIMessageChunk | Record<string, unknown>)[]): string {
  return chunks.map((chunk, i) => `id: ${i}\ndata: ${JSON.stringify(chunk)}\n\n`).join("");
}

// Helper: create a ReadableStream from SSE text
function createSSEStream(sseText: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseText));
      controller.close();
    },
  });
}

// Helper: create test UIMessages with unique IDs
let messageIdCounter = 0;

function createUserMessage(text: string): UIMessage {
  return {
    id: `msg-user-${++messageIdCounter}`,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

function createAssistantMessage(text: string): UIMessage {
  return {
    id: `msg-assistant-${++messageIdCounter}`,
    role: "assistant",
    parts: [{ type: "text", text }],
  };
}

// Sample UIMessageChunks as the AI SDK would produce
const sampleChunks: UIMessageChunk[] = [
  { type: "text-start", id: "part-1" },
  { type: "text-delta", id: "part-1", delta: "Hello" },
  { type: "text-delta", id: "part-1", delta: " world" },
  { type: "text-delta", id: "part-1", delta: "!" },
  { type: "text-end", id: "part-1" },
];

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
    it("should create transport with required options", () => {
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: "test-token",
      });

      expect(transport).toBeInstanceOf(TriggerChatTransport);
    });

    it("should accept optional configuration", () => {
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: "test-token",
        baseURL: "https://custom.trigger.dev",
        streamKey: "custom-stream",
        headers: { "X-Custom": "value" },
      });

      expect(transport).toBeInstanceOf(TriggerChatTransport);
    });

    it("should accept a function for accessToken", () => {
      let tokenCallCount = 0;
      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: () => {
          tokenCallCount++;
          return `dynamic-token-${tokenCallCount}`;
        },
      });

      expect(transport).toBeInstanceOf(TriggerChatTransport);
    });

    it("should pass chatId and purpose to accessToken when triggering a run", async () => {
      const accessTokenSpy = vi.fn().mockReturnValue("test-token");

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/api/v1/tasks/") && urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_resolve_at" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_tok",
            },
          });
        }
        if (urlStr.includes("/realtime/v1/streams/")) {
          return new Response(createSSEStream(sseEncode(sampleChunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }
        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: accessTokenSpy,
        baseURL: "https://api.test.trigger.dev",
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-access-resolve",
        messageId: undefined,
        messages: [createUserMessage("Hi")],
        abortSignal: undefined,
      });
      const reader = stream.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      expect(accessTokenSpy).toHaveBeenCalledWith({
        chatId: "chat-access-resolve",
        purpose: "trigger",
      });
    });

    it("should pass chatId and purpose preload to accessToken when preloading", async () => {
      const accessTokenSpy = vi.fn().mockReturnValue("test-token");

      global.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "run_preload_at" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-trigger-jwt": "pub_pre",
          },
        })
      );

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: accessTokenSpy,
        baseURL: "https://api.test.trigger.dev",
      });

      await transport.preload("chat-preload-access");

      expect(accessTokenSpy).toHaveBeenCalledWith({
        chatId: "chat-preload-access",
        purpose: "preload",
      });
    });
  });

  describe("sendMessages", () => {
    it("should trigger the task and return a ReadableStream of UIMessageChunks", async () => {
      const triggerRunId = "run_abc123";
      const publicToken = "pub_token_xyz";

      // Mock fetch to handle both the trigger request and the SSE stream request
      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        // Handle the task trigger request
        if (urlStr.includes("/api/v1/tasks/") && urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: triggerRunId }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": publicToken,
            },
          });
        }

        // Handle the SSE stream request
        if (urlStr.includes("/realtime/v1/streams/")) {
          const sseText = sseEncode(sampleChunks);
          return new Response(createSSEStream(sseText), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: "test-token",
        baseURL: "https://api.test.trigger.dev",
      });

      const messages: UIMessage[] = [createUserMessage("Hello!")];

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-1",
        messageId: undefined,
        messages,
        abortSignal: undefined,
      });

      expect(stream).toBeInstanceOf(ReadableStream);

      // Read all chunks from the stream
      const reader = stream.getReader();
      const receivedChunks: UIMessageChunk[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedChunks.push(value);
      }

      expect(receivedChunks).toHaveLength(sampleChunks.length);
      expect(receivedChunks[0]).toEqual({ type: "text-start", id: "part-1" });
      expect(receivedChunks[1]).toEqual({ type: "text-delta", id: "part-1", delta: "Hello" });
      expect(receivedChunks[4]).toEqual({ type: "text-end", id: "part-1" });
    });

    it("should send the correct payload to the trigger API", async () => {
      const fetchSpy = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/api/v1/tasks/") && urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_test" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_token",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          return new Response(createSSEStream(""), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      global.fetch = fetchSpy;

      const transport = new TriggerChatTransport({
        task: "my-chat-task",
        accessToken: "test-token",
        baseURL: "https://api.test.trigger.dev",
      });

      const messages: UIMessage[] = [createUserMessage("Hello!")];

      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-123",
        messageId: undefined,
        messages,
        abortSignal: undefined,
        metadata: { custom: "data" },
      });

      // Verify the trigger fetch call
      const triggerCall = fetchSpy.mock.calls.find((call: any[]) =>
        (typeof call[0] === "string" ? call[0] : call[0].toString()).includes("/trigger")
      );

      expect(triggerCall).toBeDefined();
      const triggerUrl =
        typeof triggerCall![0] === "string" ? triggerCall![0] : triggerCall![0].toString();
      expect(triggerUrl).toContain("/api/v1/tasks/my-chat-task/trigger");

      const triggerBody = JSON.parse(triggerCall![1]?.body as string);
      const payload = triggerBody.payload;
      expect(payload.messages).toEqual(messages);
      expect(payload.chatId).toBe("chat-123");
      expect(payload.trigger).toBe("submit-message");
      expect(payload.metadata).toEqual({ custom: "data" });
    });

    it("should use the correct stream URL with custom streamKey", async () => {
      const fetchSpy = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_custom" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "token",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          return new Response(createSSEStream(""), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      global.fetch = fetchSpy;

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
        streamKey: "my-custom-stream",
      });

      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-1",
        messageId: undefined,
        messages: [createUserMessage("test")],
        abortSignal: undefined,
      });

      // Verify the stream URL uses the custom stream key
      const streamCall = fetchSpy.mock.calls.find((call: any[]) =>
        (typeof call[0] === "string" ? call[0] : call[0].toString()).includes(
          "/realtime/v1/streams/"
        )
      );

      expect(streamCall).toBeDefined();
      const streamUrl =
        typeof streamCall![0] === "string" ? streamCall![0] : streamCall![0].toString();
      expect(streamUrl).toContain("/realtime/v1/streams/run_custom/my-custom-stream");
    });

    it("should include extra headers in stream requests", async () => {
      const fetchSpy = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_hdrs" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "token",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          return new Response(createSSEStream(""), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      global.fetch = fetchSpy;

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
        headers: { "X-Custom-Header": "custom-value" },
      });

      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-1",
        messageId: undefined,
        messages: [createUserMessage("test")],
        abortSignal: undefined,
      });

      // Verify the stream request includes custom headers
      const streamCall = fetchSpy.mock.calls.find((call: any[]) =>
        (typeof call[0] === "string" ? call[0] : call[0].toString()).includes(
          "/realtime/v1/streams/"
        )
      );

      expect(streamCall).toBeDefined();
      const requestHeaders = streamCall![1]?.headers as Record<string, string>;
      expect(requestHeaders["X-Custom-Header"]).toBe("custom-value");
    });
  });

  describe("reconnectToStream", () => {
    it("should return null when no session exists for chatId", async () => {
      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
      });

      const result = await transport.reconnectToStream({
        chatId: "nonexistent-chat",
      });

      expect(result).toBeNull();
    });

    it("should reconnect to an existing session", async () => {
      const triggerRunId = "run_reconnect";
      const publicToken = "pub_reconnect_token";

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: triggerRunId }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": publicToken,
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          const chunks: UIMessageChunk[] = [
            { type: "text-start", id: "part-1" },
            { type: "text-delta", id: "part-1", delta: "Reconnected!" },
            { type: "text-end", id: "part-1" },
          ];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
      });

      // First, send messages to establish a session
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-reconnect",
        messageId: undefined,
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });

      // Now reconnect
      const stream = await transport.reconnectToStream({
        chatId: "chat-reconnect",
      });

      expect(stream).toBeInstanceOf(ReadableStream);

      // Read the stream
      const reader = stream!.getReader();
      const receivedChunks: UIMessageChunk[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedChunks.push(value);
      }

      expect(receivedChunks.length).toBeGreaterThan(0);
    });

    it("should return null when session exists but isStreaming is false (TRI-8557)", async () => {
      // Simulate a session restored from DB after a completed turn
      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        sessions: {
          "chat-completed": {
            sessionId: "session_completed",
            runId: "run_completed",
            publicAccessToken: "pub_token",
            lastEventId: "42",
            isStreaming: false,
          },
        },
      });

      // reconnectToStream should return null immediately — no hanging
      const result = await transport.reconnectToStream({
        chatId: "chat-completed",
      });

      expect(result).toBeNull();
    });

    it("should reconnect when session exists and isStreaming is true", async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/realtime/v1/streams/")) {
          const chunks: UIMessageChunk[] = [
            { type: "text-start", id: "part-1" },
            { type: "text-delta", id: "part-1", delta: "Resumed!" },
            { type: "text-end", id: "part-1" },
          ];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
        sessions: {
          "chat-streaming": {
            sessionId: "session_streaming",
            runId: "run_streaming",
            publicAccessToken: "pub_token",
            lastEventId: "10",
            isStreaming: true,
          },
        },
      });

      const stream = await transport.reconnectToStream({
        chatId: "chat-streaming",
      });

      expect(stream).toBeInstanceOf(ReadableStream);
    });

    it("should set isStreaming to false via onSessionChange when turn completes", async () => {
      const sessionChanges: Array<{
        chatId: string;
        session: { isStreaming?: boolean } | null;
      }> = [];

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_streaming_flag" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_token",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          const chunks = [
            { type: "text-start", id: "part-1" },
            { type: "text-delta", id: "part-1", delta: "Hi" },
            { type: "text-end", id: "part-1" },
            { type: "trigger:turn-complete", publicAccessToken: "refreshed_token" },
          ];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
        onSessionChange: (chatId, session) => {
          sessionChanges.push({ chatId, session });
        },
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-flag-test",
        messageId: undefined,
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });

      // Drain the stream
      const reader = stream.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      // Find the session changes for this chat
      const changes = sessionChanges.filter((c) => c.chatId === "chat-flag-test");

      // First change: session created with isStreaming: true
      expect(changes[0]?.session?.isStreaming).toBe(true);

      // Last change: turn completed, isStreaming: false
      const lastChange = changes[changes.length - 1];
      expect(lastChange?.session?.isStreaming).toBe(false);
    });
  });

  describe("renewRunAccessToken", () => {
    it("reconnects after renewing PAT when SSE returns 401", async () => {
      const renewSpy = vi.fn().mockResolvedValue("fresh_pat");
      const streamFetchCountByRun = new Map<string, number>();

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_renew_sse" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_initial",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          const runMatch = urlStr.match(/\/streams\/([^/]+)\//);
          const runKey = runMatch?.[1] ?? "unknown";
          const n = (streamFetchCountByRun.get(runKey) ?? 0) + 1;
          streamFetchCountByRun.set(runKey, n);

          if (n === 2) {
            return new Response(null, { status: 401 });
          }
          const chunks: UIMessageChunk[] = [
            { type: "text-start", id: "p1" },
            { type: "text-end", id: "p1" },
          ];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "trigger-token",
        baseURL: "https://api.test.trigger.dev",
        renewRunAccessToken: renewSpy,
      });

      const firstStream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-renew-sse",
        messageId: undefined,
        messages: [createUserMessage("Hi")],
        abortSignal: undefined,
      });
      const firstReader = firstStream.getReader();
      while (true) {
        const { done } = await firstReader.read();
        if (done) break;
      }

      const stream = await transport.reconnectToStream({ chatId: "chat-renew-sse" });
      expect(stream).toBeInstanceOf(ReadableStream);

      const reader = stream!.getReader();
      const receivedChunks: UIMessageChunk[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedChunks.push(value);
      }

      expect(receivedChunks.length).toBeGreaterThan(0);
      expect(renewSpy).toHaveBeenCalledWith({
        chatId: "chat-renew-sse",
        runId: "run_renew_sse",
      });

      const patStreamCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        (call: unknown[]) => {
          const u = typeof call[0] === "string" ? call[0] : (call[0] as URL).toString();
          if (!u.includes("/realtime/v1/streams/")) return false;
          const h = (call[1] as RequestInit | undefined)?.headers as Record<string, string>;
          return h?.["Authorization"] === "Bearer fresh_pat";
        }
      );
      expect(patStreamCall).toBeDefined();
    });

    it("surfaces 401 when renewal returns no token on reconnect", async () => {
      const renewSpy = vi.fn().mockResolvedValue(undefined);
      const streamFetchCountByRun = new Map<string, number>();

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_fail_renew" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_initial",
            },
          });
        }
        if (urlStr.includes("/realtime/v1/streams/")) {
          const runMatch = urlStr.match(/\/streams\/([^/]+)\//);
          const runKey = runMatch?.[1] ?? "unknown";
          const n = (streamFetchCountByRun.get(runKey) ?? 0) + 1;
          streamFetchCountByRun.set(runKey, n);

          if (n === 1) {
            const turnDone = { type: "trigger:turn-complete", publicAccessToken: "pub_initial" };
            return new Response(createSSEStream(sseEncode([turnDone])), {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
                "X-Stream-Version": "v1",
              },
            });
          }
          return new Response(null, { status: 401 });
        }
        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "trigger-token",
        baseURL: "https://api.test.trigger.dev",
        renewRunAccessToken: renewSpy,
      });

      const firstStream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-fail-renew",
        messageId: undefined,
        messages: [createUserMessage("Hi")],
        abortSignal: undefined,
      });
      const fr = firstStream.getReader();
      while (true) {
        const { done } = await fr.read();
        if (done) break;
      }

      // Simulate mid-stream state (isStreaming must be true for reconnect to attempt)
      const session = transport.getSession("chat-fail-renew");
      transport.setOnSessionChange(undefined); // prevent side-effects
      // Re-seed with isStreaming: true to simulate reconnect during an active turn
      (transport as any).sessions.set("chat-fail-renew", {
        ...session,
        isStreaming: true,
      });

      const stream = await transport.reconnectToStream({ chatId: "chat-fail-renew" });
      const reader = stream!.getReader();
      await expect(reader.read()).rejects.toMatchObject({ status: 401 });
      expect(renewSpy).toHaveBeenCalledWith({
        chatId: "chat-fail-renew",
        runId: "run_fail_renew",
      });
    });

    it("retries sendInputStream after 401 when renewRunAccessToken returns a new PAT", async () => {
      let inputCalls = 0;
      const renewSpy = vi.fn().mockResolvedValue("pat_after_renew");

      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_input_renew" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_session",
            },
          });
        }

        if (urlStr.includes("/input/")) {
          inputCalls++;
          if (inputCalls === 1) {
            return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
          }
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          const completeChunk = { type: "trigger:turn-complete", publicAccessToken: "pat_hold" };
          return new Response(createSSEStream(sseEncode([completeChunk])), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "trigger-token",
        baseURL: "https://api.test.trigger.dev",
        renewRunAccessToken: renewSpy,
      });

      const s1 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-first",
        messageId: undefined,
        messages: [createUserMessage("One")],
        abortSignal: undefined,
      });
      const r1 = s1.getReader();
      while (true) {
        const { done } = await r1.read();
        if (done) break;
      }

      const s2 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-first",
        messageId: undefined,
        messages: [createUserMessage("One"), createUserMessage("Two")],
        abortSignal: undefined,
      });
      const r2 = s2.getReader();
      while (true) {
        const { done } = await r2.read();
        if (done) break;
      }

      expect(renewSpy).toHaveBeenCalledWith({
        chatId: "chat-first",
        runId: "run_input_renew",
      });
      expect(inputCalls).toBe(2);
    });
  });

  describe("createChatTransport", () => {
    it("should create a TriggerChatTransport instance", () => {
      const transport = createChatTransport({
        task: "my-task",
        accessToken: "token",
      });

      expect(transport).toBeInstanceOf(TriggerChatTransport);
    });

    it("should pass options through to the transport", () => {
      const transport = createChatTransport({
        task: "custom-task",
        accessToken: "custom-token",
        baseURL: "https://custom.example.com",
        streamKey: "custom-key",
        headers: { "X-Test": "value" },
      });

      expect(transport).toBeInstanceOf(TriggerChatTransport);
    });
  });

  describe("publicAccessToken from trigger response", () => {
    it("should use x-trigger-jwt from trigger response as the stream auth token", async () => {
      const fetchSpy = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          // Return with x-trigger-jwt header — this public token should be
          // used for the subsequent stream subscription request.
          return new Response(JSON.stringify({ id: "run_pat" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "server-generated-public-token",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          // Verify the Authorization header uses the server-generated token
          const authHeader = (init?.headers as Record<string, string>)?.["Authorization"];
          expect(authHeader).toBe("Bearer server-generated-public-token");

          const chunks: UIMessageChunk[] = [
            { type: "text-start", id: "p1" },
            { type: "text-end", id: "p1" },
          ];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      global.fetch = fetchSpy;

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "caller-token",
        baseURL: "https://api.test.trigger.dev",
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-pat",
        messageId: undefined,
        messages: [createUserMessage("test")],
        abortSignal: undefined,
      });

      // Consume the stream
      const reader = stream.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      // Verify the stream subscription used the public token, not the caller token
      const streamCall = fetchSpy.mock.calls.find((call: any[]) =>
        (typeof call[0] === "string" ? call[0] : call[0].toString()).includes(
          "/realtime/v1/streams/"
        )
      );
      expect(streamCall).toBeDefined();
      const streamHeaders = streamCall![1]?.headers as Record<string, string>;
      expect(streamHeaders["Authorization"]).toBe("Bearer server-generated-public-token");
    });
  });

  describe("error handling", () => {
    it("should propagate trigger API errors", async () => {
      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ error: "Task not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "nonexistent-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
      });

      await expect(
        transport.sendMessages({
          trigger: "submit-message",
          chatId: "chat-error",
          messageId: undefined,
          messages: [createUserMessage("test")],
          abortSignal: undefined,
        })
      ).rejects.toThrow();
    });
  });

  describe("abort signal", () => {
    it("should close the stream gracefully when aborted", async () => {
      let streamResolve: (() => void) | undefined;
      const streamWait = new Promise<void>((resolve) => {
        streamResolve = resolve;
      });

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_abort" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "token",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          // Create a slow stream that waits before sending data
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(
                  `id: 0\ndata: ${JSON.stringify({ type: "text-start", id: "p1" })}\n\n`
                )
              );
              // Wait for the test to signal it's done
              await streamWait;
              controller.close();
            },
          });

          return new Response(stream, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const abortController = new AbortController();

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-abort",
        messageId: undefined,
        messages: [createUserMessage("test")],
        abortSignal: abortController.signal,
      });

      // Read the first chunk
      const reader = stream.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);

      // Abort and clean up
      abortController.abort();
      streamResolve?.();

      // The stream should close — reading should return done
      const next = await reader.read();
      expect(next.done).toBe(true);
    });
  });

  describe("multiple sessions", () => {
    it("should track multiple chat sessions independently", async () => {
      let callCount = 0;

      const turnCompleteChunk = { type: "trigger:turn-complete" };

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          callCount++;
          return new Response(JSON.stringify({ id: `run_multi_${callCount}` }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": `token_${callCount}`,
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          // Include turn-complete chunk so the session is preserved
          const chunks = [...sampleChunks, turnCompleteChunk];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
      });

      // Start two independent chat sessions and consume the streams
      const s1 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "session-a",
        messageId: undefined,
        messages: [createUserMessage("Hello A")],
        abortSignal: undefined,
      });
      const r1 = s1.getReader();
      while (!(await r1.read()).done) {}

      const s2 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "session-b",
        messageId: undefined,
        messages: [createUserMessage("Hello B")],
        abortSignal: undefined,
      });
      const r2 = s2.getReader();
      while (!(await r2.read()).done) {}

      // Both sessions should exist but not be reconnectable (turns completed)
      const sessionA = transport.getSession("session-a");
      const sessionB = transport.getSession("session-b");
      expect(sessionA).toBeDefined();
      expect(sessionB).toBeDefined();
      expect(sessionA!.isStreaming).toBe(false);
      expect(sessionB!.isStreaming).toBe(false);

      // Completed turns return null on reconnect (TRI-8557 fix)
      const streamA = await transport.reconnectToStream({ chatId: "session-a" });
      const streamB = await transport.reconnectToStream({ chatId: "session-b" });
      const streamC = await transport.reconnectToStream({ chatId: "nonexistent" });

      expect(streamA).toBeNull();
      expect(streamB).toBeNull();
      expect(streamC).toBeNull();
    });
  });

  describe("dynamic accessToken", () => {
    it("should call the accessToken function for each sendMessages call", async () => {
      let tokenCallCount = 0;

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: `run_dyn_${tokenCallCount}` }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "stream-token",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          const chunks: UIMessageChunk[] = [
            { type: "text-start", id: "p1" },
            { type: "text-end", id: "p1" },
          ];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: () => {
          tokenCallCount++;
          return `dynamic-token-${tokenCallCount}`;
        },
        baseURL: "https://api.test.trigger.dev",
      });

      // First call — the token function should be invoked
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-dyn-1",
        messageId: undefined,
        messages: [createUserMessage("first")],
        abortSignal: undefined,
      });

      const firstCount = tokenCallCount;
      expect(firstCount).toBeGreaterThanOrEqual(1);

      // Second call — the token function should be invoked again
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-dyn-2",
        messageId: undefined,
        messages: [createUserMessage("second")],
        abortSignal: undefined,
      });

      // Token function was called at least once more
      expect(tokenCallCount).toBeGreaterThan(firstCount);
    });
  });

  describe("body merging", () => {
    it("should merge ChatRequestOptions.body into the task payload", async () => {
      const fetchSpy = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_body" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "token",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          return new Response(createSSEStream(""), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      global.fetch = fetchSpy;

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
      });

      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-body",
        messageId: undefined,
        messages: [createUserMessage("test")],
        abortSignal: undefined,
        body: { systemPrompt: "You are helpful", temperature: 0.7 },
      });

      const triggerCall = fetchSpy.mock.calls.find((call: any[]) =>
        (typeof call[0] === "string" ? call[0] : call[0].toString()).includes("/trigger")
      );

      const triggerBody = JSON.parse(triggerCall![1]?.body as string);
      const payload = triggerBody.payload;

      // body properties should be merged into the payload
      expect(payload.systemPrompt).toBe("You are helpful");
      expect(payload.temperature).toBe(0.7);
      // Standard fields should still be present
      expect(payload.chatId).toBe("chat-body");
      expect(payload.trigger).toBe("submit-message");
    });
  });

  describe("message types", () => {
    it("should handle regenerate-message trigger", async () => {
      const fetchSpy = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_regen" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "token",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          return new Response(createSSEStream(""), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      global.fetch = fetchSpy;

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
      });

      const messages: UIMessage[] = [
        createUserMessage("Hello!"),
        createAssistantMessage("Hi there!"),
      ];

      await transport.sendMessages({
        trigger: "regenerate-message",
        chatId: "chat-regen",
        messageId: "msg-to-regen",
        messages,
        abortSignal: undefined,
      });

      // Verify the payload includes the regenerate trigger type and messageId
      const triggerCall = fetchSpy.mock.calls.find((call: any[]) =>
        (typeof call[0] === "string" ? call[0] : call[0].toString()).includes("/trigger")
      );

      const triggerBody = JSON.parse(triggerCall![1]?.body as string);
      const payload = triggerBody.payload;
      expect(payload.trigger).toBe("regenerate-message");
      expect(payload.messageId).toBe("msg-to-regen");
    });
  });

  describe("lastEventId tracking", () => {
    it("should pass lastEventId to SSE subscription on subsequent turns", async () => {
      const turnCompleteChunk = { type: "trigger:turn-complete" };

      let triggerCallCount = 0;
      const streamFetchCalls: { url: string; headers: Record<string, string> }[] = [];

      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/api/v1/tasks/") && urlStr.includes("/trigger")) {
          triggerCallCount++;
          return new Response(JSON.stringify({ id: "run_eid" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_token_eid",
            },
          });
        }

        // Handle input stream sends (for second message)
        if (urlStr.includes("/realtime/v1/streams/") && urlStr.includes("/input/")) {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          streamFetchCalls.push({
            url: urlStr,
            headers: (init?.headers as Record<string, string>) ?? {},
          });

          const chunks = [
            ...sampleChunks,
            { type: "finish" as const, id: "part-1" } as UIMessageChunk,
            turnCompleteChunk,
          ];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
      });

      // First message — triggers a new run
      const stream1 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-eid",
        messageId: undefined,
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });

      const reader1 = stream1.getReader();
      while (true) {
        const { done } = await reader1.read();
        if (done) break;
      }

      // Second message — sends via input stream
      const stream2 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-eid",
        messageId: undefined,
        messages: [
          createUserMessage("Hello"),
          createAssistantMessage("Hi!"),
          createUserMessage("What's up?"),
        ],
        abortSignal: undefined,
      });

      const reader2 = stream2.getReader();
      while (true) {
        const { done } = await reader2.read();
        if (done) break;
      }

      // The second stream subscription should include a Last-Event-ID header
      expect(streamFetchCalls.length).toBe(2);
      const secondStreamHeaders = streamFetchCalls[1]!.headers;
      // SSEStreamSubscription passes lastEventId as the Last-Event-ID header
      expect(secondStreamHeaders["Last-Event-ID"]).toBeDefined();
    });
  });

  describe("minimal wire payloads", () => {
    it("should send only new messages via input stream on turn 2+", async () => {
      const turnCompleteChunk = { type: "trigger:turn-complete" };
      const inputStreamPayloads: any[] = [];

      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/api/v1/tasks/") && urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_minimal" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_token_minimal",
            },
          });
        }

        // Capture input stream payloads (ApiClient wraps in { data: ... })
        if (urlStr.includes("/realtime/v1/streams/") && urlStr.includes("/input/")) {
          const body = JSON.parse(init?.body as string);
          inputStreamPayloads.push(body.data);
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          const chunks = [...sampleChunks, turnCompleteChunk];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
      });

      const userMsg1 = createUserMessage("Hello");
      const assistantMsg = createAssistantMessage("Hi there!");
      const userMsg2 = createUserMessage("What's up?");

      // Turn 1 — triggers a new run with full history
      const stream1 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-minimal",
        messageId: undefined,
        messages: [userMsg1],
        abortSignal: undefined,
      });
      const r1 = stream1.getReader();
      while (!(await r1.read()).done) {}

      // Turn 2 — sends via input stream, should only include NEW messages
      const stream2 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-minimal",
        messageId: undefined,
        messages: [userMsg1, assistantMsg, userMsg2],
        abortSignal: undefined,
      });
      const r2 = stream2.getReader();
      while (!(await r2.read()).done) {}

      // Verify: the input stream payload should only contain the new user message
      expect(inputStreamPayloads).toHaveLength(1);
      const sentPayload = inputStreamPayloads[0];
      // Only the new user message should be sent (backend already has the assistant response)
      expect(sentPayload.messages).toHaveLength(1);
      expect(sentPayload.messages[0]).toEqual(userMsg2);
    });

    it("should send full history on first message (trigger)", async () => {
      let triggerPayload: any;

      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/api/v1/tasks/") && urlStr.includes("/trigger")) {
          triggerPayload = JSON.parse(init?.body as string);
          return new Response(JSON.stringify({ id: "run_full" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_token_full",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          return new Response(createSSEStream(sseEncode(sampleChunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
      });

      const messages = [
        createUserMessage("Hello"),
        createAssistantMessage("Hi!"),
        createUserMessage("More"),
      ];

      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-full",
        messageId: undefined,
        messages,
        abortSignal: undefined,
      });

      // First message always sends full history via trigger
      expect(triggerPayload.payload.messages).toHaveLength(3);
    });
  });

  describe("AbortController cleanup", () => {
    it("should terminate SSE connection after intercepting control chunk", async () => {
      const controlChunk = { type: "trigger:turn-complete" };

      let streamAborted = false;

      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_abort_cleanup" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_token",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          // Track abort signal
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => {
              streamAborted = true;
            });
          }

          const chunks = [
            ...sampleChunks,
            { type: "finish" as const, id: "part-1" } as UIMessageChunk,
            controlChunk,
          ];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-abort-cleanup",
        messageId: undefined,
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });

      // Consume all chunks
      const reader = stream.getReader();
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }

      // The internal AbortController should have aborted the fetch
      expect(streamAborted).toBe(true);
    });
  });

  describe("async accessToken", () => {
    it("should accept an async function for accessToken", async () => {
      let tokenCallCount = 0;

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: `run_async_${tokenCallCount}` }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "stream-token",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          const chunks: UIMessageChunk[] = [
            { type: "text-start", id: "p1" },
            { type: "text-end", id: "p1" },
          ];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: async () => {
          tokenCallCount++;
          // Simulate async work (e.g. server action)
          await new Promise((r) => setTimeout(r, 1));
          return `async-token-${tokenCallCount}`;
        },
        baseURL: "https://api.test.trigger.dev",
      });

      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-async",
        messageId: undefined,
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });

      expect(tokenCallCount).toBe(1);
    });

    it("should not resolve async token for input stream send flow", async () => {
      const turnCompleteChunk = { type: "trigger:turn-complete" };

      let tokenCallCount = 0;
      let inputStreamSendCalled = false;

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/api/v1/tasks/") && urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_async_wp" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "stream-token",
            },
          });
        }

        // Handle input stream sends
        if (urlStr.includes("/realtime/v1/streams/") && urlStr.includes("/input/")) {
          inputStreamSendCalled = true;
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          const chunks = [
            ...sampleChunks,
            { type: "finish" as const, id: "part-1" } as UIMessageChunk,
            turnCompleteChunk,
          ];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: async () => {
          tokenCallCount++;
          await new Promise((r) => setTimeout(r, 1));
          return `async-wp-token-${tokenCallCount}`;
        },
        baseURL: "https://api.test.trigger.dev",
      });

      // First message — triggers a new run (calls async token)
      const stream1 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-async-wp",
        messageId: undefined,
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });

      const reader1 = stream1.getReader();
      while (true) {
        const { done } = await reader1.read();
        if (done) break;
      }

      const firstTokenCount = tokenCallCount;

      // Second message — should send via input stream (does NOT call async token)
      const stream2 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-async-wp",
        messageId: undefined,
        messages: [
          createUserMessage("Hello"),
          createAssistantMessage("Hi!"),
          createUserMessage("More"),
        ],
        abortSignal: undefined,
      });

      const reader2 = stream2.getReader();
      while (true) {
        const { done } = await reader2.read();
        if (done) break;
      }

      // Token function should NOT have been called again for the input stream path
      expect(tokenCallCount).toBe(firstTokenCount);
      expect(inputStreamSendCalled).toBe(true);
    });
  });

  describe("single-run mode (input stream loop)", () => {
    it("should not forward turn-complete control chunk to consumer", async () => {
      const turnCompleteChunk = { type: "trigger:turn-complete" };

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_single" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_token",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          const chunks = [
            ...sampleChunks,
            { type: "finish" as const, id: "part-1" } as UIMessageChunk,
            turnCompleteChunk,
          ];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-single",
        messageId: undefined,
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });

      // Read all chunks — the control chunk should NOT appear
      const reader = stream.getReader();
      const receivedChunks: UIMessageChunk[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        receivedChunks.push(value);
      }

      // All AI SDK chunks should be forwarded
      expect(receivedChunks.length).toBe(sampleChunks.length + 1); // +1 for the finish chunk
      // Control chunk should not be in the output
      expect(receivedChunks.every((c) => c.type !== ("trigger:turn-complete" as any))).toBe(true);
    });

    it("should send via input stream on second message instead of triggering a new run", async () => {
      const turnCompleteChunk = { type: "trigger:turn-complete" };

      let triggerCallCount = 0;
      let inputStreamSendCalled = false;

      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/api/v1/tasks/") && urlStr.includes("/trigger")) {
          triggerCallCount++;
          return new Response(JSON.stringify({ id: "run_resume" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_token",
            },
          });
        }

        // Handle input stream sends
        if (urlStr.includes("/realtime/v1/streams/") && urlStr.includes("/input/")) {
          inputStreamSendCalled = true;
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          const chunks = [
            ...sampleChunks,
            { type: "finish" as const, id: "part-1" } as UIMessageChunk,
            turnCompleteChunk,
          ];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
      });

      // First message — triggers a new run
      const stream1 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-resume",
        messageId: undefined,
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });

      // Consume stream
      const reader1 = stream1.getReader();
      while (true) {
        const { done } = await reader1.read();
        if (done) break;
      }

      expect(triggerCallCount).toBe(1);

      // Second message — should send via input stream instead of triggering
      const stream2 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-resume",
        messageId: undefined,
        messages: [
          createUserMessage("Hello"),
          createAssistantMessage("Hi!"),
          createUserMessage("How are you?"),
        ],
        abortSignal: undefined,
      });

      // Consume second stream
      const reader2 = stream2.getReader();
      while (true) {
        const { done } = await reader2.read();
        if (done) break;
      }

      // Should NOT have triggered a second run
      expect(triggerCallCount).toBe(1);
      // Should have sent via input stream
      expect(inputStreamSendCalled).toBe(true);
    });

    it("should fall back to triggering a new run if stream closes without control chunk", async () => {
      let triggerCallCount = 0;

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/api/v1/tasks/") && urlStr.includes("/trigger")) {
          triggerCallCount++;
          return new Response(JSON.stringify({ id: `run_fallback_${triggerCallCount}` }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_token",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          // No control chunk — stream just ends after the finish
          const chunks: UIMessageChunk[] = [
            { type: "text-start", id: "p1" },
            { type: "text-delta", id: "p1", delta: "Hello" },
            { type: "text-end", id: "p1" },
          ];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
      });

      // First message
      const stream1 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-fallback",
        messageId: undefined,
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });

      const reader1 = stream1.getReader();
      while (true) {
        const { done } = await reader1.read();
        if (done) break;
      }

      expect(triggerCallCount).toBe(1);

      // Second message — no waitpoint token stored, should trigger a new run
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-fallback",
        messageId: undefined,
        messages: [
          createUserMessage("Hello"),
          createAssistantMessage("Hi!"),
          createUserMessage("Again"),
        ],
        abortSignal: undefined,
      });

      // Should have triggered a second run
      expect(triggerCallCount).toBe(2);
    });

    it("should fall back to new run when sendInputStream fails", async () => {
      const turnCompleteChunk = { type: "trigger:turn-complete" };

      let triggerCallCount = 0;

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/api/v1/tasks/") && urlStr.includes("/trigger")) {
          triggerCallCount++;
          return new Response(JSON.stringify({ id: `run_fail_${triggerCallCount}` }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_token",
            },
          });
        }

        // Input stream send fails
        if (urlStr.includes("/realtime/v1/streams/") && urlStr.includes("/input/")) {
          return new Response(JSON.stringify({ error: "Run not found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          const chunks: (UIMessageChunk | Record<string, unknown>)[] = [
            ...sampleChunks,
            { type: "finish" as const, id: "part-1" } as UIMessageChunk,
            turnCompleteChunk,
          ];

          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
      });

      // First message
      const stream1 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-fail",
        messageId: undefined,
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });

      const reader1 = stream1.getReader();
      while (true) {
        const { done } = await reader1.read();
        if (done) break;
      }

      expect(triggerCallCount).toBe(1);

      // Second message — sendInputStream will fail, should fall back to new run
      const stream2 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-fail",
        messageId: undefined,
        messages: [
          createUserMessage("Hello"),
          createAssistantMessage("Hi!"),
          createUserMessage("Again"),
        ],
        abortSignal: undefined,
      });

      const reader2 = stream2.getReader();
      while (true) {
        const { done } = await reader2.read();
        if (done) break;
      }

      // Should have triggered a second run as fallback
      expect(triggerCallCount).toBe(2);
    });
  });

  describe("onSessionChange", () => {
    it("should fire when a new session is created", async () => {
      const onSessionChange = vi.fn();
      const triggerRunId = "run_session_new";
      const publicToken = "pub_session_new";

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: triggerRunId }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": publicToken,
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          const chunks = [...sampleChunks, { type: "trigger:turn-complete" }];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
        onSessionChange,
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-1",
        messageId: undefined,
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });

      // Session created notification should have fired
      expect(onSessionChange).toHaveBeenCalledWith("chat-1", {
        runId: triggerRunId,
        publicAccessToken: publicToken,
        lastEventId: undefined,
        isStreaming: true,
      });

      // Consume stream
      const reader = stream.getReader();
      while (!(await reader.read()).done) {}

      // Should also fire with updated lastEventId on turn complete
      const lastCall = onSessionChange.mock.calls[onSessionChange.mock.calls.length - 1]!;
      expect(lastCall![0]).toBe("chat-1");
      expect(lastCall![1]).not.toBeNull();
      expect(lastCall![1].lastEventId).toBeDefined();
    });

    it("should preserve session when stream ends naturally (run stays alive between turns)", async () => {
      const onSessionChange = vi.fn();

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_end" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_end",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          // No turn-complete chunk — stream ends naturally (run completed)
          return new Response(createSSEStream(sseEncode(sampleChunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
        onSessionChange,
      });

      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-end",
        messageId: undefined,
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });

      // Consume the stream fully
      const reader = stream.getReader();
      while (!(await reader.read()).done) {}

      // Session should have been created but NOT deleted — the run stays
      // alive between turns and the session is needed for reconnection.
      expect(onSessionChange).toHaveBeenCalledWith(
        "chat-end",
        expect.objectContaining({
          runId: "run_end",
        })
      );
      expect(onSessionChange).not.toHaveBeenCalledWith("chat-end", null);
    });

    it("should be updatable via setOnSessionChange", async () => {
      const onSessionChange1 = vi.fn();
      const onSessionChange2 = vi.fn();

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(JSON.stringify({ id: "run_update" }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-trigger-jwt": "pub_update",
            },
          });
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          const chunks = [...sampleChunks, { type: "trigger:turn-complete" }];
          return new Response(createSSEStream(sseEncode(chunks)), {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "X-Stream-Version": "v1",
            },
          });
        }

        throw new Error(`Unexpected fetch URL: ${urlStr}`);
      });

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
        onSessionChange: onSessionChange1,
      });

      // Update the callback before sending
      transport.setOnSessionChange(onSessionChange2);

      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-update",
        messageId: undefined,
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });

      // Only onSessionChange2 should have been called
      expect(onSessionChange1).not.toHaveBeenCalled();
      expect(onSessionChange2).toHaveBeenCalled();
    });
  });
});
