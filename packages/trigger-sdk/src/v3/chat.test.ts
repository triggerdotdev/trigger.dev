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
          return new Response(
            JSON.stringify({ id: triggerRunId }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": publicToken,
              },
            }
          );
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
          return new Response(
            JSON.stringify({ id: "run_test" }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "pub_token",
              },
            }
          );
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
      const triggerUrl = typeof triggerCall![0] === "string" ? triggerCall![0] : triggerCall![0].toString();
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
          return new Response(
            JSON.stringify({ id: "run_custom" }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "token",
              },
            }
          );
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
        (typeof call[0] === "string" ? call[0] : call[0].toString()).includes("/realtime/v1/streams/")
      );

      expect(streamCall).toBeDefined();
      const streamUrl = typeof streamCall![0] === "string" ? streamCall![0] : streamCall![0].toString();
      expect(streamUrl).toContain("/realtime/v1/streams/run_custom/my-custom-stream");
    });

    it("should include extra headers in stream requests", async () => {
      const fetchSpy = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(
            JSON.stringify({ id: "run_hdrs" }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "token",
              },
            }
          );
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
        (typeof call[0] === "string" ? call[0] : call[0].toString()).includes("/realtime/v1/streams/")
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
          return new Response(
            JSON.stringify({ id: triggerRunId }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": publicToken,
              },
            }
          );
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
          return new Response(
            JSON.stringify({ id: "run_pat" }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "server-generated-public-token",
              },
            }
          );
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
        (typeof call[0] === "string" ? call[0] : call[0].toString()).includes("/realtime/v1/streams/")
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
          return new Response(
            JSON.stringify({ error: "Task not found" }),
            {
              status: 404,
              headers: { "content-type": "application/json" },
            }
          );
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
          return new Response(
            JSON.stringify({ id: "run_abort" }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "token",
              },
            }
          );
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          // Create a slow stream that waits before sending data
          const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
              const encoder = new TextEncoder();
              controller.enqueue(
                encoder.encode(`id: 0\ndata: ${JSON.stringify({ type: "text-start", id: "p1" })}\n\n`)
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

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          callCount++;
          return new Response(
            JSON.stringify({ id: `run_multi_${callCount}` }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": `token_${callCount}`,
              },
            }
          );
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

      const transport = new TriggerChatTransport({
        task: "my-task",
        accessToken: "token",
        baseURL: "https://api.test.trigger.dev",
      });

      // Start two independent chat sessions
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "session-a",
        messageId: undefined,
        messages: [createUserMessage("Hello A")],
        abortSignal: undefined,
      });

      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "session-b",
        messageId: undefined,
        messages: [createUserMessage("Hello B")],
        abortSignal: undefined,
      });

      // Both sessions should be independently reconnectable
      const streamA = await transport.reconnectToStream({ chatId: "session-a" });
      const streamB = await transport.reconnectToStream({ chatId: "session-b" });
      const streamC = await transport.reconnectToStream({ chatId: "nonexistent" });

      expect(streamA).toBeInstanceOf(ReadableStream);
      expect(streamB).toBeInstanceOf(ReadableStream);
      expect(streamC).toBeNull();
    });
  });

  describe("dynamic accessToken", () => {
    it("should call the accessToken function for each sendMessages call", async () => {
      let tokenCallCount = 0;

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(
            JSON.stringify({ id: `run_dyn_${tokenCallCount}` }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "stream-token",
              },
            }
          );
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
          return new Response(
            JSON.stringify({ id: "run_body" }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "token",
              },
            }
          );
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
          return new Response(
            JSON.stringify({ id: "run_regen" }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "token",
              },
            }
          );
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
      const controlChunk = {
        type: "__trigger_waitpoint_ready",
        tokenId: "wp_token_eid",
        publicAccessToken: "wp_access_eid",
      };

      let triggerCallCount = 0;
      const streamFetchCalls: { url: string; headers: Record<string, string> }[] = [];

      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/api/v1/tasks/") && urlStr.includes("/trigger")) {
          triggerCallCount++;
          return new Response(
            JSON.stringify({ id: "run_eid" }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "pub_token_eid",
              },
            }
          );
        }

        if (urlStr.includes("/api/v1/waitpoints/tokens/") && urlStr.includes("/complete")) {
          return new Response(
            JSON.stringify({ success: true }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          );
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          streamFetchCalls.push({
            url: urlStr,
            headers: (init?.headers as Record<string, string>) ?? {},
          });

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

      // Second message — completes the waitpoint
      const stream2 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-eid",
        messageId: undefined,
        messages: [createUserMessage("Hello"), createAssistantMessage("Hi!"), createUserMessage("What's up?")],
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

  describe("AbortController cleanup", () => {
    it("should terminate SSE connection after intercepting control chunk", async () => {
      const controlChunk = {
        type: "__trigger_waitpoint_ready",
        tokenId: "wp_token_abort",
        publicAccessToken: "wp_access_abort",
      };

      let streamAborted = false;

      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(
            JSON.stringify({ id: "run_abort_cleanup" }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "pub_token",
              },
            }
          );
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
          return new Response(
            JSON.stringify({ id: `run_async_${tokenCallCount}` }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "stream-token",
              },
            }
          );
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

    it("should resolve async token for waitpoint completion flow", async () => {
      const controlChunk = {
        type: "__trigger_waitpoint_ready",
        tokenId: "wp_token_async",
        publicAccessToken: "wp_access_async",
      };

      let tokenCallCount = 0;
      let completeWaitpointCalled = false;

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/api/v1/tasks/") && urlStr.includes("/trigger")) {
          return new Response(
            JSON.stringify({ id: "run_async_wp" }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "stream-token",
              },
            }
          );
        }

        if (urlStr.includes("/api/v1/waitpoints/tokens/") && urlStr.includes("/complete")) {
          completeWaitpointCalled = true;
          return new Response(
            JSON.stringify({ success: true }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          );
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
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

      // Second message — should complete waitpoint (does NOT call async token)
      const stream2 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-async-wp",
        messageId: undefined,
        messages: [createUserMessage("Hello"), createAssistantMessage("Hi!"), createUserMessage("More")],
        abortSignal: undefined,
      });

      const reader2 = stream2.getReader();
      while (true) {
        const { done } = await reader2.read();
        if (done) break;
      }

      // Token function should NOT have been called again for the waitpoint path
      expect(tokenCallCount).toBe(firstTokenCount);
      expect(completeWaitpointCalled).toBe(true);
    });
  });

  describe("single-run mode (waitpoint loop)", () => {
    it("should store waitpoint token from control chunk and not forward it to consumer", async () => {
      const controlChunk = {
        type: "__trigger_waitpoint_ready",
        tokenId: "wp_token_123",
        publicAccessToken: "wp_access_abc",
      };

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/trigger")) {
          return new Response(
            JSON.stringify({ id: "run_single" }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "pub_token",
              },
            }
          );
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
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
      expect(receivedChunks.every((c) => c.type !== ("__trigger_waitpoint_ready" as any))).toBe(true);
    });

    it("should complete waitpoint token on second message instead of triggering a new run", async () => {
      const controlChunk = {
        type: "__trigger_waitpoint_ready",
        tokenId: "wp_token_456",
        publicAccessToken: "wp_access_def",
      };

      let triggerCallCount = 0;
      let completeWaitpointCalled = false;

      global.fetch = vi.fn().mockImplementation(async (url: string | URL, init?: RequestInit) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/api/v1/tasks/") && urlStr.includes("/trigger")) {
          triggerCallCount++;
          return new Response(
            JSON.stringify({ id: "run_resume" }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "pub_token",
              },
            }
          );
        }

        // Handle waitpoint token completion
        if (urlStr.includes("/api/v1/waitpoints/tokens/") && urlStr.includes("/complete")) {
          completeWaitpointCalled = true;
          return new Response(
            JSON.stringify({ success: true }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            }
          );
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
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

      // First message — triggers a new run
      const stream1 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-resume",
        messageId: undefined,
        messages: [createUserMessage("Hello")],
        abortSignal: undefined,
      });

      // Consume stream to capture the control chunk
      const reader1 = stream1.getReader();
      while (true) {
        const { done } = await reader1.read();
        if (done) break;
      }

      expect(triggerCallCount).toBe(1);

      // Second message — should complete the waitpoint instead of triggering
      const stream2 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-resume",
        messageId: undefined,
        messages: [createUserMessage("Hello"), createAssistantMessage("Hi!"), createUserMessage("How are you?")],
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
      // Should have completed the waitpoint
      expect(completeWaitpointCalled).toBe(true);
    });

    it("should fall back to triggering a new run if stream closes without control chunk", async () => {
      let triggerCallCount = 0;

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/api/v1/tasks/") && urlStr.includes("/trigger")) {
          triggerCallCount++;
          return new Response(
            JSON.stringify({ id: `run_fallback_${triggerCallCount}` }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "pub_token",
              },
            }
          );
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
        messages: [createUserMessage("Hello"), createAssistantMessage("Hi!"), createUserMessage("Again")],
        abortSignal: undefined,
      });

      // Should have triggered a second run
      expect(triggerCallCount).toBe(2);
    });

    it("should fall back to new run when completing waitpoint fails", async () => {
      const controlChunk = {
        type: "__trigger_waitpoint_ready",
        tokenId: "wp_token_fail",
        publicAccessToken: "wp_access_fail",
      };

      let triggerCallCount = 0;

      global.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
        const urlStr = typeof url === "string" ? url : url.toString();

        if (urlStr.includes("/api/v1/tasks/") && urlStr.includes("/trigger")) {
          triggerCallCount++;
          return new Response(
            JSON.stringify({ id: `run_fail_${triggerCallCount}` }),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                "x-trigger-jwt": "pub_token",
              },
            }
          );
        }

        // Waitpoint completion fails
        if (urlStr.includes("/api/v1/waitpoints/tokens/") && urlStr.includes("/complete")) {
          return new Response(
            JSON.stringify({ error: "Token expired" }),
            {
              status: 400,
              headers: { "content-type": "application/json" },
            }
          );
        }

        if (urlStr.includes("/realtime/v1/streams/")) {
          // First call has control chunk, subsequent calls don't
          const chunks: (UIMessageChunk | Record<string, unknown>)[] = [
            ...sampleChunks,
            { type: "finish" as const, id: "part-1" } as UIMessageChunk,
          ];

          if (triggerCallCount <= 1) {
            chunks.push(controlChunk);
          }

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

      // Second message — waitpoint completion will fail, should fall back to new run
      const stream2 = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-fail",
        messageId: undefined,
        messages: [createUserMessage("Hello"), createAssistantMessage("Hi!"), createUserMessage("Again")],
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
});
