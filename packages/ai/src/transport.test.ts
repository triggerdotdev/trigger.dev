import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UIMessage, UIMessageChunk } from "ai";
import { TriggerChatTransport, createChatTransport } from "./transport.js";

// Helper: encode text as SSE format
function sseEncode(chunks: UIMessageChunk[]): string {
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

// Helper: create test UIMessages
function createUserMessage(text: string): UIMessage {
  return {
    id: `msg-${Date.now()}`,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

function createAssistantMessage(text: string): UIMessage {
  return {
    id: `msg-${Date.now()}`,
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
        taskId: "my-chat-task",
        accessToken: "test-token",
      });

      expect(transport).toBeInstanceOf(TriggerChatTransport);
    });

    it("should accept optional configuration", () => {
      const transport = new TriggerChatTransport({
        taskId: "my-chat-task",
        accessToken: "test-token",
        baseURL: "https://custom.trigger.dev",
        streamKey: "custom-stream",
        headers: { "X-Custom": "value" },
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
        taskId: "my-chat-task",
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
        taskId: "my-chat-task",
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
      const payload = JSON.parse(triggerBody.payload);
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
        taskId: "my-task",
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
        taskId: "my-task",
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
        taskId: "my-task",
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
        taskId: "my-task",
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
        taskId: "my-task",
        accessToken: "token",
      });

      expect(transport).toBeInstanceOf(TriggerChatTransport);
    });

    it("should pass options through to the transport", () => {
      const transport = createChatTransport({
        taskId: "custom-task",
        accessToken: "custom-token",
        baseURL: "https://custom.example.com",
        streamKey: "custom-key",
        headers: { "X-Test": "value" },
      });

      expect(transport).toBeInstanceOf(TriggerChatTransport);
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
        taskId: "nonexistent-task",
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
        taskId: "my-task",
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
        taskId: "my-task",
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
        taskId: "my-task",
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
      const payload = JSON.parse(triggerBody.payload);

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
        taskId: "my-task",
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
      const payload = JSON.parse(triggerBody.payload);
      expect(payload.trigger).toBe("regenerate-message");
      expect(payload.messageId).toBe("msg-to-regen");
    });
  });
});
