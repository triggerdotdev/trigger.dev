import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  InMemoryTriggerChatRunStore,
  createTriggerChatTransport,
  TriggerChatTransport,
} from "./chatTransport.js";
import type { UIMessage, UIMessageChunk } from "ai";
import type {
  TriggerChatRunState,
  TriggerChatRunStore,
} from "./types.js";

type TestServer = {
  url: string;
  close: () => Promise<void>;
};

const activeServers: TestServer[] = [];

afterEach(async function () {
  while (activeServers.length > 0) {
    const server = activeServers.pop();
    if (server) {
      await server.close();
    }
  }
});

describe("TriggerChatTransport", function () {
  it("triggers task and streams chunks with rich default payload", async function () {
    let receivedTriggerBody: Record<string, unknown> | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        readJsonBody(req).then(function (body) {
          receivedTriggerBody = body;
          res.writeHead(200, {
            "content-type": "application/json",
            "x-trigger-jwt": "pk_run_123",
          });
          res.end(JSON.stringify({ id: "run_123" }));
        });
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_123/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });

        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "msg_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-delta", id: "msg_1", delta: "Hello" })
        );
        writeSSE(
          res,
          "3-0",
          JSON.stringify({ type: "text-end", id: "msg_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-1",
      messageId: undefined,
      messages: [
        {
          id: "usr_1",
          role: "user",
          parts: [{ type: "text", text: "Hello there" }],
        } satisfies UIMessage,
      ],
      abortSignal: undefined,
      headers: new Headers([["x-test-header", "abc123"]]),
      body: { tenantId: "tenant_1" },
      metadata: { source: "unit-test" },
    });

    const chunks = await readChunks(stream);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({
      type: "text-start",
      chunk: { type: "text-start", id: "msg_1" },
    });
    expect(chunks[1]).toMatchObject({
      type: "text-delta",
      chunk: { type: "text-delta", id: "msg_1", delta: "Hello" },
    });
    expect(chunks[2]).toMatchObject({
      type: "text-end",
      chunk: { type: "text-end", id: "msg_1" },
    });

    expect(receivedTriggerBody).toBeDefined();

    const options = (receivedTriggerBody?.options ?? {}) as Record<string, unknown>;
    expect(options.payloadType).toBe("application/super+json");

    const payloadString = receivedTriggerBody?.payload as string;
    const payload = (JSON.parse(payloadString) as { json: Record<string, unknown> }).json;

    expect(payload.chatId).toBe("chat-1");
    expect(payload.trigger).toBe("submit-message");
    expect(payload.messageId).toBeNull();
    expect(payload.messages).toHaveLength(1);
    expect(payload.request).toEqual({
      headers: {
        "x-test-header": "abc123",
      },
      body: { tenantId: "tenant_1" },
      metadata: { source: "unit-test" },
    });
  });

  it("returns null on reconnect when no active run exists", async function () {
    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: "https://api.trigger.dev",
    });

    const stream = await transport.reconnectToStream({
      chatId: "missing-chat",
    });

    expect(stream).toBeNull();
  });

  it("supports custom payload mapping and trigger options resolver", async function () {
    let receivedTriggerBody: Record<string, unknown> | undefined;
    let receivedResolverChatId: string | undefined;
    let receivedResolverHeader: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        readJsonBody(req).then(function (body) {
          receivedTriggerBody = body;
          res.writeHead(200, {
            "content-type": "application/json",
            "x-trigger-jwt": "pk_run_789",
          });
          res.end(JSON.stringify({ id: "run_789" }));
        });
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_789/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "mapped_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "mapped_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport<
      UIMessage,
      {
        prompt: string;
        chatId: string;
        sourceHeader: string | undefined;
      }
    >({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      payloadMapper: function payloadMapper(request) {
        const firstMessage = request.messages[0];
        const firstPart = firstMessage?.parts[0];
        const prompt =
          firstPart && firstPart.type === "text"
            ? firstPart.text
            : "";

        return {
          prompt,
          chatId: request.chatId,
          sourceHeader: request.request.headers?.["x-source"],
        };
      },
      triggerOptions: function triggerOptions(request) {
        receivedResolverChatId = request.chatId;
        receivedResolverHeader = request.request.headers?.["x-source"];

        return {
          queue: "chat-queue",
          concurrencyKey: `chat-${request.chatId}`,
          idempotencyKey: `idem-${request.chatId}`,
          ttl: "30m",
          tags: ["chat", "mapped"],
          metadata: {
            requester: request.request.headers?.["x-source"] ?? "unknown",
          },
          priority: 50,
        };
      },
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-mapped",
      messageId: undefined,
      messages: [
        {
          id: "mapped-user",
          role: "user",
          parts: [{ type: "text", text: "Map me" }],
        } satisfies UIMessage,
      ],
      abortSignal: undefined,
      headers: {
        "x-source": "sdk-test",
      },
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      chunk: { type: "text-start", id: "mapped_1" },
    });
    expect(chunks[1]).toMatchObject({
      chunk: { type: "text-end", id: "mapped_1" },
    });

    expect(receivedResolverChatId).toBe("chat-mapped");
    expect(receivedResolverHeader).toBe("sdk-test");

    expect(receivedTriggerBody).toBeDefined();
    const payloadString = receivedTriggerBody?.payload as string;
    const payload = (JSON.parse(payloadString) as { json: Record<string, unknown> }).json;
    expect(payload).toEqual({
      prompt: "Map me",
      chatId: "chat-mapped",
      sourceHeader: "sdk-test",
    });

    const options = (receivedTriggerBody?.options ?? {}) as Record<string, unknown>;
    expect(options.queue).toEqual({ name: "chat-queue" });
    expect(options.concurrencyKey).toBe("chat-chat-mapped");
    expect(options.ttl).toBe("30m");
    expect(options.tags).toEqual(["chat", "mapped"]);
    expect(options.metadata).toEqual({ requester: "sdk-test" });
    expect(options.priority).toBe(50);
    expect(typeof options.idempotencyKey).toBe("string");
    expect((options.idempotencyKey as string).length).toBe(64);
  });

  it("supports creating transport with factory function", async function () {
    let observedRunId: string | undefined;

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_factory",
        });
        res.end(JSON.stringify({ id: "run_factory" }));
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_factory/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "factory_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "factory_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = createTriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      onTriggeredRun: function onTriggeredRun(state) {
        observedRunId = state.runId;
      },
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-factory",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);
    expect(observedRunId).toBe("run_factory");
  });

  it("cleans run store state when stream completes", async function () {
    const trackedRunStore = new TrackedRunStore();

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_cleanup",
        });
        res.end(JSON.stringify({ id: "run_cleanup" }));
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_cleanup/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "cleanup_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "cleanup_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore: trackedRunStore,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-cleanup",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);

    await waitForCondition(function () {
      return trackedRunStore.deleteCalls.includes("chat-cleanup");
    });

    expect(trackedRunStore.get("chat-cleanup")).toBeUndefined();
  });

  it("returns null from reconnect after stream completion cleanup", async function () {
    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_done",
        });
        res.end(JSON.stringify({ id: "run_done" }));
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_done/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "done_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "done_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-done",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);

    await waitForCondition(async function () {
      const reconnect = await transport.reconnectToStream({
        chatId: "chat-done",
      });

      return reconnect === null;
    });
  });

  it("supports async run store implementations", async function () {
    const runStore = new AsyncTrackedRunStore();

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_async",
        });
        res.end(JSON.stringify({ id: "run_async" }));
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_async/chat-stream") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "async_1" })
        );
        writeSSE(
          res,
          "2-0",
          JSON.stringify({ type: "text-end", id: "async_1" })
        );
        res.end();
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-async",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    const chunks = await readChunks(stream);
    expect(chunks).toHaveLength(2);

    await waitForCondition(function () {
      return runStore.deleteCalls.includes("chat-async");
    });

    expect(runStore.setCalls).toContain("chat-async");
    expect(runStore.getCalls).toContain("chat-async");
    await expect(runStore.get("chat-async")).resolves.toBeUndefined();
  });

  it("reconnects active streams using tracked lastEventId", async function () {
    let reconnectLastEventId: string | undefined;
    let firstStreamResponse: ServerResponse<IncomingMessage> | undefined;
    let firstStreamChunkSent = false;
    const runStore = new InMemoryTriggerChatRunStore();

    const server = await startServer(function (req, res) {
      if (req.method === "POST" && req.url === "/api/v1/tasks/chat-task/trigger") {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-trigger-jwt": "pk_run_456",
        });
        res.end(JSON.stringify({ id: "run_456" }));
        return;
      }

      if (req.method === "GET" && req.url === "/realtime/v1/streams/run_456/chat-stream") {
        const lastEventId = req.headers["last-event-id"];
        const normalizedLastEventId = Array.isArray(lastEventId)
          ? lastEventId[0]
          : lastEventId;

        if (typeof normalizedLastEventId === "string") {
          reconnectLastEventId = normalizedLastEventId;
          res.writeHead(200, {
            "content-type": "text/event-stream",
          });
          writeSSE(
            res,
            "2-0",
            JSON.stringify({ type: "text-delta", id: "msg_2", delta: "world" })
          );
          writeSSE(
            res,
            "3-0",
            JSON.stringify({ type: "text-end", id: "msg_2" })
          );
          res.end();
          return;
        }

        firstStreamResponse = res;
        res.writeHead(200, {
          "content-type": "text/event-stream",
        });
        writeSSE(
          res,
          "1-0",
          JSON.stringify({ type: "text-start", id: "msg_2" })
        );
        firstStreamChunkSent = true;
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const transport = new TriggerChatTransport({
      task: "chat-task",
      stream: "chat-stream",
      accessToken: "pk_trigger",
      baseURL: server.url,
      runStore,
    });

    try {
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-2",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      });

      await waitForCondition(function () {
        if (!firstStreamChunkSent) {
          return false;
        }

        const state = runStore.get("chat-2");
        return Boolean(state && state.lastEventId === "1-0");
      });

      const reconnectStream = await transport.reconnectToStream({
        chatId: "chat-2",
      });

      expect(reconnectStream).not.toBeNull();

      const reconnectChunks = await readChunks(reconnectStream!);
      expect(reconnectLastEventId).toBe("1-0");
      expect(reconnectChunks).toHaveLength(2);
      expect(reconnectChunks[0]).toMatchObject({
        chunk: { type: "text-delta", id: "msg_2", delta: "world" },
      });
      expect(reconnectChunks[1]).toMatchObject({
        chunk: { type: "text-end", id: "msg_2" },
      });
    } finally {
      if (firstStreamResponse) {
        firstStreamResponse.end();
      }
    }
  });
});

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse<IncomingMessage>) => void
) {
  const nodeServer = createServer(handler);

  await new Promise<void>(function (resolve) {
    nodeServer.listen(0, "127.0.0.1", function () {
      resolve();
    });
  });

  const address = nodeServer.address() as AddressInfo;
  const server: TestServer = {
    url: `http://127.0.0.1:${address.port}`,
    close: function () {
      if (typeof nodeServer.closeAllConnections === "function") {
        nodeServer.closeAllConnections();
      }

      return new Promise<void>(function (resolve, reject) {
        nodeServer.close(function (error) {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };

  activeServers.push(server);

  return server;
}

function writeSSE(res: ServerResponse<IncomingMessage>, id: string, data: string) {
  res.write(`id: ${id}\n`);
  res.write(`data: ${data}\n\n`);
}

async function readJsonBody(req: IncomingMessage) {
  const chunks: string[] = [];
  for await (const chunk of req) {
    chunks.push(chunk.toString());
  }
  return JSON.parse(chunks.join("")) as Record<string, unknown>;
}

async function readChunks(stream: ReadableStream<UIMessageChunk>) {
  const parts: Array<{ type: string; id?: string; chunk: UIMessageChunk }> = [];
  for await (const chunk of stream) {
    const part: { type: string; id?: string; chunk: UIMessageChunk } = {
      type: chunk.type,
      chunk,
    };

    if ("id" in chunk && typeof chunk.id === "string") {
      part.id = chunk.id;
    }

    parts.push(part);
  }

  return parts;
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutInMs = 5000
) {
  const start = Date.now();

  while (Date.now() - start < timeoutInMs) {
    if (await condition()) {
      return;
    }

    await new Promise<void>(function (resolve) {
      setTimeout(resolve, 25);
    });
  }

  throw new Error(`Condition was not met within ${timeoutInMs}ms`);
}

class TrackedRunStore extends InMemoryTriggerChatRunStore {
  public readonly deleteCalls: string[] = [];

  public delete(chatId: string): void {
    this.deleteCalls.push(chatId);
    super.delete(chatId);
  }
}

class AsyncTrackedRunStore implements TriggerChatRunStore {
  private readonly runs = new Map<string, TriggerChatRunState>();
  public readonly getCalls: string[] = [];
  public readonly setCalls: string[] = [];
  public readonly deleteCalls: string[] = [];

  public async get(chatId: string): Promise<TriggerChatRunState | undefined> {
    this.getCalls.push(chatId);
    await sleep(1);
    return this.runs.get(chatId);
  }

  public async set(state: TriggerChatRunState): Promise<void> {
    this.setCalls.push(state.chatId);
    await sleep(1);
    this.runs.set(state.chatId, state);
  }

  public async delete(chatId: string): Promise<void> {
    this.deleteCalls.push(chatId);
    await sleep(1);
    this.runs.delete(chatId);
  }
}

async function sleep(timeoutInMs: number) {
  await new Promise<void>(function (resolve) {
    setTimeout(resolve, timeoutInMs);
  });
}
